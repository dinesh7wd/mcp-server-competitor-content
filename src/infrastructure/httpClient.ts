import { ErrorCodes, McpError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export interface HttpRequest {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly retries: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createHttpClient(): HttpClient {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      let lastErr: unknown;
      const attempts = req.retries + 1;
      for (let i = 0; i < attempts; i += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), req.timeoutMs);
        try {
          const init: RequestInit = { method: req.method ?? "GET", signal: controller.signal };
          if (req.headers) init.headers = req.headers;
          if (req.body) init.body = req.body;
          const res = await fetch(req.url, init);
          const body = await res.text();
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            headers[k.toLowerCase()] = v;
          });
          if ((res.status === 429 || res.status >= 500) && i < attempts - 1) {
            logger.warn("http_retry", { url: req.url, status: res.status, attempt: i });
            await sleep(200 * 2 ** i);
            continue;
          }
          return { status: res.status, body, headers };
        } catch (err) {
          lastErr = err;
          if (err instanceof Error && err.name === "AbortError") {
            throw new McpError(ErrorCodes.Timeout, `Timeout: ${req.url}`);
          }
          if (i < attempts - 1) {
            await sleep(200 * 2 ** i);
            continue;
          }
        } finally {
          clearTimeout(timer);
        }
      }
      throw new McpError(
        ErrorCodes.InternalError,
        lastErr instanceof Error ? lastErr.message : "HTTP failed",
      );
    },
  };
}
