import dns from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";
import { ErrorCodes, McpError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { redactSecrets, safeUrlForLog } from "../utils/redact.js";
import { assertSafeHttpUrl, createPinnedLookup, type LookupFn } from "../utils/validators.js";

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
  /** When true, bodies over maxBodyBytes are cut instead of rejected. */
  readonly truncateBody?: boolean;
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
  close?(): Promise<void>;
}

export interface FetchInit {
  readonly method: string;
  readonly redirect: "manual";
  readonly signal: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface FetchResponseLike {
  readonly status: number;
  readonly headers: { forEach(cb: (value: string, key: string) => void): void };
  readonly body: ReadableStream<Uint8Array> | null;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export interface HttpClientOptions {
  readonly timeoutMs?: number;
  readonly retries?: number;
  /** DNS resolver used for both pre-flight validation and the pinned socket lookup. */
  readonly lookup?: LookupFn;
  /** Test seam; the default is undici fetch through a pinned-lookup Agent. */
  readonly fetchImpl?: FetchLike;
}

interface HopState {
  url: string;
  redirects: number;
  method: "GET" | "POST";
  body: string | undefined;
}

interface ClientDeps {
  readonly lookup: LookupFn;
  readonly fetchImpl: FetchLike;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

/** DNS lookups ignore AbortSignal; race them so the request timeout still applies. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function normalizeHeaders(headers: FetchResponseLike["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((v, k) => {
    result[k.toLowerCase()] = v;
  });
  return result;
}

async function readLimitedBody(
  body: FetchResponseLike["body"],
  maxBytes: number,
  truncate: boolean,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined);
      if (!truncate) {
        throw new McpError(ErrorCodes.ScrapeFail, `Response exceeded ${maxBytes} byte limit`);
      }
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks, total));
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
    return base === want || base.startsWith(`${want}+`);
  });
}

function buildInit(state: HopState, req: HttpRequest, signal: AbortSignal): FetchInit {
  return {
    method: state.method,
    redirect: "manual",
    signal,
    ...(req.headers ? { headers: req.headers } : {}),
    ...(state.body !== undefined ? { body: state.body } : {}),
  };
}

function advanceRedirect(
  state: HopState,
  status: number,
  location: string | undefined,
  maxRedirects: number,
): void {
  if (!location) throw new McpError(ErrorCodes.ScrapeFail, "Redirect without Location header");
  let next: string;
  try {
    next = new URL(location, state.url).href;
  } catch {
    throw new McpError(ErrorCodes.ScrapeFail, "Invalid redirect Location header");
  }
  if (state.redirects >= maxRedirects) {
    throw new McpError(ErrorCodes.ScrapeFail, `Exceeded ${maxRedirects} redirects`);
  }
  state.redirects += 1;
  state.url = next;
  if (status === 303 || ((status === 301 || status === 302) && state.method === "POST")) {
    state.method = "GET";
    state.body = undefined;
  }
}

async function finishResponse(
  res: FetchResponseLike,
  headers: Record<string, string>,
  state: HopState,
  req: HttpRequest,
): Promise<HttpResponse> {
  const ok = res.status >= 200 && res.status < 300;
  if (ok && !contentTypeAllowed(headers["content-type"], req.allowedContentTypes)) {
    await res.body?.cancel().catch(() => undefined);
    throw new McpError(
      ErrorCodes.ScrapeFail,
      `Disallowed content-type: ${headers["content-type"] ?? "missing"}`,
    );
  }
  const maxBytes = req.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const body = await readLimitedBody(res.body, maxBytes, req.truncateBody === true);
  return { status: res.status, body, headers, finalUrl: state.url, redirectCount: state.redirects };
}

async function followRedirects(
  state: HopState,
  req: HttpRequest,
  signal: AbortSignal,
  deps: ClientDeps,
): Promise<HttpResponse> {
  const maxRedirects = req.maxRedirects ?? 5;
  const validate = req.validateRedirects !== false;
  for (;;) {
    if (validate) await raceAbort(assertSafeHttpUrl(state.url, deps.lookup), signal);
    const res = await deps.fetchImpl(state.url, buildInit(state, req, signal));
    const headers = normalizeHeaders(res.headers);
    if (!REDIRECT_STATUSES.has(res.status)) return finishResponse(res, headers, state, req);
    await res.body?.cancel().catch(() => undefined);
    advanceRedirect(state, res.status, headers.location, maxRedirects);
  }
}

function errorCause(err: unknown): unknown {
  return err instanceof Error ? err.cause : undefined;
}

/** Errors that must not be retried. */
function fatalError(err: unknown, url: string): McpError | undefined {
  if (err instanceof McpError) return err;
  const cause = errorCause(err);
  if (cause instanceof McpError) return cause;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new McpError(ErrorCodes.Timeout, `Timeout: ${safeUrlForLog(url)}`);
  }
  return undefined;
}

function networkFailure(err: unknown, url: string): McpError {
  const cause = errorCause(err);
  const code =
    cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : err instanceof Error
        ? redactSecrets(err.message)
        : "unknown";
  return new McpError(ErrorCodes.ScrapeFail, `Network error (${code}) for ${safeUrlForLog(url)}`);
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function defaultFetch(lookup: LookupFn): { fetchImpl: FetchLike; agent: Agent } {
  const agent = new Agent({ connect: { lookup: createPinnedLookup(lookup) } });
  const fetchImpl: FetchLike = (url, init) => undiciFetch(url, { ...init, dispatcher: agent });
  return { fetchImpl, agent };
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const defaultTimeout = options.timeoutMs ?? 10_000;
  const defaultRetries = options.retries ?? 2;
  const lookup = options.lookup ?? dns.lookup;
  const pinned = options.fetchImpl ? undefined : defaultFetch(lookup);
  const fetchImpl = options.fetchImpl ?? pinned?.fetchImpl;
  if (!fetchImpl) throw new Error("fetch implementation unavailable");
  const deps: ClientDeps = { lookup, fetchImpl };

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const timeoutMs = req.timeoutMs ?? defaultTimeout;
      const attempts = (req.retries ?? defaultRetries) + 1;
      const state: HopState = {
        url: req.url,
        redirects: 0,
        method: req.method ?? "GET",
        body: req.body,
      };
      let lastErr: unknown;

      for (let i = 0; i < attempts; i += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await followRedirects(state, req, controller.signal, deps);
          if (!shouldRetryStatus(res.status) || i === attempts - 1) return res;
          logger.warn("http_retry", { url: safeUrlForLog(state.url), status: res.status, attempt: i });
        } catch (err) {
          const fatal = fatalError(err, state.url);
          if (fatal) throw fatal;
          lastErr = err;
          if (i === attempts - 1) break;
        } finally {
          clearTimeout(timer);
        }
        await sleep(200 * 2 ** i);
      }
      throw networkFailure(lastErr, state.url);
    },
    async close(): Promise<void> {
      await pinned?.agent.close();
    },
  };
}
