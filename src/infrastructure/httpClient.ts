import { ErrorCodes, McpError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { redactSecrets, safeUrlForLog } from "../utils/redact.js";
import { assertSafeHttpUrl } from "../utils/validators.js";

export interface HttpRequest {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  /** When true (default), follow redirects manually with SSRF re-check. */
  readonly validateRedirects?: boolean;
  readonly maxRedirects?: number;
  readonly maxBodyBytes?: number;
  readonly allowedContentTypes?: readonly string[];
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly finalUrl: string;
  readonly redirectCount: number;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((v, k) => {
    result[k.toLowerCase()] = v;
  });
  return result;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new McpError(ErrorCodes.ScrapeFail, `Response exceeded ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(combined);
}

function contentTypeAllowed(
  contentType: string | undefined,
  allowed: readonly string[] | undefined,
): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (!contentType) return false;
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return allowed.some((a) => {
    const want = a.toLowerCase();
    return base === want || base.startsWith(`${want}+`) || base.includes(want);
  });
}

async function fetchOnce(
  url: string,
  req: HttpRequest,
  signal: AbortSignal,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const init: RequestInit = {
    method: req.method ?? "GET",
    signal,
    redirect: "manual",
  };
  if (req.headers) init.headers = req.headers;
  if (req.body) init.body = req.body;

  const res = await fetch(url, init);
  const headers = normalizeHeaders(res.headers);
  const maxBytes = req.maxBodyBytes ?? 2 * 1024 * 1024;
  const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
  const body = isRedirect ? "" : await readLimitedBody(res, maxBytes);
  return { status: res.status, headers, body };
}

export function createHttpClient(defaults?: {
  timeoutMs?: number;
  retries?: number;
}): HttpClient {
  const defaultTimeout = defaults?.timeoutMs ?? 10_000;
  const defaultRetries = defaults?.retries ?? 2;

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const validateRedirects = req.validateRedirects !== false;
      const maxRedirects = req.maxRedirects ?? 5;
      const timeoutMs = req.timeoutMs ?? defaultTimeout;
      const retries = req.retries ?? defaultRetries;
      let currentUrl = req.url;
      let redirectCount = 0;
      let lastErr: unknown;
      const attempts = retries + 1;

      for (let i = 0; i < attempts; i += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          while (redirectCount <= maxRedirects) {
            if (validateRedirects) {
              await assertSafeHttpUrl(currentUrl);
            }
            const result = await fetchOnce(currentUrl, req, controller.signal);

            if ([301, 302, 303, 307, 308].includes(result.status)) {
              const location = result.headers.location;
              if (!location) {
                throw new McpError(ErrorCodes.ScrapeFail, "Redirect without Location header");
              }
              currentUrl = new URL(location, currentUrl).href;
              redirectCount += 1;
              if (validateRedirects) {
                await assertSafeHttpUrl(currentUrl);
              }
              continue;
            }

            if (
              req.allowedContentTypes &&
              result.status >= 200 &&
              result.status < 300 &&
              !contentTypeAllowed(result.headers["content-type"], req.allowedContentTypes)
            ) {
              throw new McpError(
                ErrorCodes.ScrapeFail,
                `Disallowed content-type: ${result.headers["content-type"] ?? "missing"}`,
              );
            }

            if ((result.status === 429 || result.status >= 500) && i < attempts - 1) {
              logger.warn("http_retry", {
                url: safeUrlForLog(currentUrl),
                status: result.status,
                attempt: i,
              });
              await sleep(200 * 2 ** i);
              break;
            }

            return {
              status: result.status,
              body: result.body,
              headers: result.headers,
              finalUrl: currentUrl,
              redirectCount,
            };
          }
          if (redirectCount > maxRedirects) {
            throw new McpError(ErrorCodes.ScrapeFail, `Exceeded ${maxRedirects} redirects`);
          }
        } catch (err) {
          lastErr = err;
          if (err instanceof McpError) throw err;
          if (err instanceof Error && err.name === "AbortError") {
            throw new McpError(ErrorCodes.Timeout, `Timeout: ${safeUrlForLog(currentUrl)}`);
          }
          if (i < attempts - 1) {
            await sleep(200 * 2 ** i);
            continue;
          }
        } finally {
          clearTimeout(timer);
        }
      }
      const msg =
        lastErr instanceof Error ? redactSecrets(lastErr.message) : "HTTP failed";
      throw new McpError(ErrorCodes.InternalError, msg);
    },
  };
}
