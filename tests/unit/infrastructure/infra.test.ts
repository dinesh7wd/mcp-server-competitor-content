import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import { LruCache } from "../../../src/infrastructure/cache.js";
import { createContentFetcher } from "../../../src/infrastructure/contentFetcher.js";
import type { HeadlessRenderer } from "../../../src/infrastructure/headlessRenderer.js";
import type { HttpClient } from "../../../src/infrastructure/httpClient.js";
import { createDomainRateLimiter } from "../../../src/infrastructure/rateLimiter.js";
import { createRobotsChecker, __robotsTest } from "../../../src/infrastructure/robotsChecker.js";
import { createSerpProvider } from "../../../src/infrastructure/serpProvider.js";
import { ErrorCodes } from "../../../src/utils/errors.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");

describe("infrastructure", () => {
  it("caches robots rulesets and allows paths", async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: "User-agent: *\nDisallow: /private\n",
      headers: {},
    });
    const http = { request } as HttpClient;
    const cache = new LruCache(10, 60);
    const config = loadConfig({ ...process.env, RESPECT_ROBOTS_TXT: "true" });
    const robots = createRobotsChecker(http, config, cache);
    expect(await robots.isAllowed("https://ex.com/ok")).toBe(true);
    expect(await robots.isAllowed("https://ex.com/private/x")).toBe(false);
    expect(await robots.isAllowed("https://ex.com/ok2")).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("parses robots allow/disallow", () => {
    const rules = __robotsTest.parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/public\n", "bot");
    expect(__robotsTest.pathAllowed("/a/x", rules)).toBe(false);
    expect(__robotsTest.pathAllowed("/a/public", rules)).toBe(true);
  });

  it("falls back to headless on thin SPA HTML", async () => {
    const thin = readFileSync(join(fixtures, "thin-spa.html"), "utf8");
    const rich = readFileSync(join(fixtures, "article.html"), "utf8");
    const request = vi.fn().mockResolvedValue({ status: 200, body: thin, headers: {} });
    const headless: HeadlessRenderer = { render: vi.fn().mockResolvedValue(rich) };
    const config = loadConfig({
      ...process.env,
      RESPECT_ROBOTS_TXT: "false",
      ENABLE_HEADLESS_FALLBACK: "true",
      HEADLESS_MIN_CONTENT_CHARS: "200",
      RATE_LIMIT_DELAY_MS: "0",
    });
    const fetcher = createContentFetcher({
      http: { request } as HttpClient,
      cache: new LruCache(10, 60),
      robots: { isAllowed: async () => true },
      rateLimiter: createDomainRateLimiter(0),
      headless,
      config,
    });
    const page = await fetcher.fetchPage("https://example.com/spa");
    expect(page.usedHeadless).toBe(true);
    expect(page.bodyText.length).toBeGreaterThan(200);
    expect(headless.render).toHaveBeenCalled();
  });

  it("fails serp when unconfigured", async () => {
    const config = loadConfig({ ...process.env, SERP_PROVIDER: undefined, SERP_API_KEY: undefined });
    const serp = createSerpProvider({ request: vi.fn() } as unknown as HttpClient, config);
    await expect(serp.getSerpFeatures("running shoes")).rejects.toMatchObject({
      code: ErrorCodes.SerpUnconfigured,
    });
  });
});
