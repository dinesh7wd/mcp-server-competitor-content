export const ErrorCodes = {
  InvalidParams: "InvalidParams",
  InternalError: "InternalError",
  ScrapeFail: "SCRAPE_FAIL",
  ParseError: "PARSE_ERROR",
  RobotsDisallowed: "ROBOTS_DISALLOWED",
  RateLimited: "RATE_LIMITED",
  NoContent: "NO_CONTENT",
  SerpUnconfigured: "SERP_PROVIDER_UNCONFIGURED",
  HeadlessFail: "HEADLESS_RENDER_FAIL",
  SsrfBlocked: "SSRF_BLOCKED",
  ProviderConfig: "PROVIDER_CONFIG",
  Timeout: "TIMEOUT",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class McpError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "McpError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details?: Readonly<Record<string, unknown>> } {
    if (this.details !== undefined) {
      return { code: this.code, message: this.message, details: this.details };
    }
    return { code: this.code, message: this.message };
  }
}

export function isMcpError(value: unknown): value is McpError {
  return value instanceof McpError;
}

export function toMcpError(err: unknown): McpError {
  if (isMcpError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new McpError(ErrorCodes.InternalError, message);
}
