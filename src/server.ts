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
import type { LookupFn } from "./utils/validators.js";

export interface InfraOverrides {
  readonly http?: HttpClient;
  readonly fetcher?: ContentFetcher;
  readonly serp?: SerpProvider;
  readonly headless?: HeadlessRenderer;
  readonly cache?: LruCache;
  readonly lookup?: LookupFn;
}

export interface AppInstance {
  readonly services: AppServices;
  close(): Promise<void>;
}

export interface ServerInstance {
  readonly server: McpServer;
  close(): Promise<void>;
}

export function createApp(config: AppConfig, overrides: InfraOverrides = {}): AppInstance {
  const { lookup } = overrides;
  const cache = overrides.cache ?? new LruCache(256, config.cacheTtlSeconds);
  const http =
    overrides.http ??
    createHttpClient({
      timeoutMs: config.httpTimeoutMs,
      retries: config.httpRetries,
      ...(lookup ? { lookup } : {}),
    });
  const robots = createRobotsChecker(http, config, cache);
  const rateLimiter = createDomainRateLimiter(config.rateLimitDelayMs);
  const headless = overrides.headless ?? createHeadlessRenderer(config, lookup);
  const fetcher =
    overrides.fetcher ??
    createContentFetcher({
      http,
      cache,
      robots,
      rateLimiter,
      headless,
      config,
      ...(lookup ? { lookup } : {}),
    });
  const serp = overrides.serp ?? createSerpProvider(http, config);
  return {
    services: createServices(fetcher, serp),
    async close(): Promise<void> {
      await Promise.allSettled([headless.close?.(), http.close?.()]);
    },
  };
}

export function createAppServices(config: AppConfig, overrides: InfraOverrides = {}): AppServices {
  return createApp(config, overrides).services;
}

export function createServer(config: AppConfig, overrides: InfraOverrides = {}): ServerInstance {
  const app = createApp(config, overrides);
  const server = new McpServer({
    name: "mcp-server-competitor-content",
    version: "1.1.0",
  });
  registerTools(server, app.services, config);
  return {
    server,
    async close(): Promise<void> {
      await app.close();
      await server.close();
    },
  };
}
