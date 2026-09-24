import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { LruCache } from "./infrastructure/cache.js";
import { createContentFetcher, type ContentFetcher } from "./infrastructure/contentFetcher.js";
import { createHeadlessRenderer, type HeadlessRenderer } from "./infrastructure/headlessRenderer.js";
import { createHttpClient, type HttpClient } from "./infrastructure/httpClient.js";
import { createDomainRateLimiter } from "./infrastructure/rateLimiter.js";
import { createRobotsChecker } from "./infrastructure/robotsChecker.js";
import { createSerpProvider, type SerpProvider } from "./infrastructure/serpProvider.js";
import { createServices, type AppServices } from "./services/index.js";
import { registerTools } from "./tools/index.js";

export interface InfraOverrides {
  readonly http?: HttpClient;
  readonly fetcher?: ContentFetcher;
  readonly serp?: SerpProvider;
  readonly headless?: HeadlessRenderer;
  readonly cache?: LruCache;
}

export function createAppServices(config: AppConfig, overrides: InfraOverrides = {}): AppServices {
  const cache = overrides.cache ?? new LruCache(256, config.cacheTtlSeconds);
  const http = overrides.http ?? createHttpClient();
  const robots = createRobotsChecker(http, config, cache);
  const rateLimiter = createDomainRateLimiter(config.rateLimitDelayMs);
  const headless = overrides.headless ?? createHeadlessRenderer(config);
  const fetcher =
    overrides.fetcher ??
    createContentFetcher({ http, cache, robots, rateLimiter, headless, config });
  const serp = overrides.serp ?? createSerpProvider(http, config);
  return createServices(fetcher, serp);
}

export function createServer(config: AppConfig, overrides: InfraOverrides = {}): McpServer {
  const server = new McpServer({
    name: "mcp-server-competitor-content",
    version: "1.0.0",
  });
  registerTools(server, createAppServices(config, overrides), config);
  return server;
}
