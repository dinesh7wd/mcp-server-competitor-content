import { z } from "zod";
import { ErrorCodes, McpError } from "./utils/errors.js";
import { setLogLevel, type LogLevel } from "./utils/logger.js";

const envSchema = z.object({
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  RESPECT_ROBOTS_TXT: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  RATE_LIMIT_DELAY_MS: z.coerce.number().int().nonnegative().default(1000),
  MAX_CONCURRENT_FETCHES: z.coerce.number().int().positive().default(3),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  ROBOTS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  HTTP_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  USER_AGENT: z.string().default("mcp-server-competitor-content/1.0 (+https://github.com/your-org/mcp-server-competitor-content)"),
  SERP_PROVIDER: z.enum(["serpapi", "dataforseo", "google_cse"]).optional(),
  SERP_API_KEY: z.string().min(1).optional(),
  SERP_API_REGION: z.string().default("us"),
  ENABLE_HEADLESS_FALLBACK: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  HEADLESS_MIN_CONTENT_CHARS: z.coerce.number().int().nonnegative().default(200),
  HEADLESS_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  EMBEDDING_PROVIDER: z.enum(["openai", "gemini"]).optional(),
  EMBEDDING_API_KEY: z.string().min(1).optional(),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export interface AppConfig {
  readonly logLevel: LogLevel;
  readonly respectRobotsTxt: boolean;
  readonly rateLimitDelayMs: number;
  readonly maxConcurrentFetches: number;
  readonly cacheTtlSeconds: number;
  readonly robotsCacheTtlSeconds: number;
  readonly httpTimeoutMs: number;
  readonly httpRetries: number;
  readonly userAgent: string;
  readonly serpProvider?: "serpapi" | "dataforseo" | "google_cse";
  readonly serpApiKey?: string;
  readonly serpApiRegion: string;
  readonly enableHeadlessFallback: boolean;
  readonly headlessMinContentChars: number;
  readonly headlessTimeoutMs: number;
  readonly embeddingProvider?: "openai" | "gemini";
  readonly embeddingApiKey?: string;
  readonly embeddingModel: string;
  readonly nodeEnv: "development" | "production" | "test";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new McpError(
      ErrorCodes.ProviderConfig,
      `Invalid environment: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const d = parsed.data;
  if (d.EMBEDDING_PROVIDER && !d.EMBEDDING_API_KEY) {
    throw new McpError(ErrorCodes.ProviderConfig, "EMBEDDING_API_KEY required when EMBEDDING_PROVIDER is set");
  }
  setLogLevel(d.LOG_LEVEL);
  const config: AppConfig = {
    logLevel: d.LOG_LEVEL,
    respectRobotsTxt: d.RESPECT_ROBOTS_TXT,
    rateLimitDelayMs: d.RATE_LIMIT_DELAY_MS,
    maxConcurrentFetches: d.MAX_CONCURRENT_FETCHES,
    cacheTtlSeconds: d.CACHE_TTL_SECONDS,
    robotsCacheTtlSeconds: d.ROBOTS_CACHE_TTL_SECONDS,
    httpTimeoutMs: d.HTTP_TIMEOUT_MS,
    httpRetries: d.HTTP_RETRIES,
    userAgent: d.USER_AGENT,
    serpApiRegion: d.SERP_API_REGION,
    enableHeadlessFallback: d.ENABLE_HEADLESS_FALLBACK,
    headlessMinContentChars: d.HEADLESS_MIN_CONTENT_CHARS,
    headlessTimeoutMs: d.HEADLESS_TIMEOUT_MS,
    embeddingModel: d.EMBEDDING_MODEL,
    nodeEnv: d.NODE_ENV,
  };
  return {
    ...config,
    ...(d.SERP_PROVIDER !== undefined ? { serpProvider: d.SERP_PROVIDER } : {}),
    ...(d.SERP_API_KEY !== undefined ? { serpApiKey: d.SERP_API_KEY } : {}),
    ...(d.EMBEDDING_PROVIDER !== undefined ? { embeddingProvider: d.EMBEDDING_PROVIDER } : {}),
    ...(d.EMBEDDING_API_KEY !== undefined ? { embeddingApiKey: d.EMBEDDING_API_KEY } : {}),
  };
}
