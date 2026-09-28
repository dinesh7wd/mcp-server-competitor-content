import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, type AppConfig } from "../../../src/config.js";
import { LruCache } from "../../../src/infrastructure/cache.js";
import {
  createContentFetcher,
  isHiddenStyle,
  parseHtmlToPage,
  toScrapeToolResult,
  type ContentFetcher,
  type ContentFetcherDeps,
} from "../../../src/infrastructure/contentFetcher.js";
import type { HeadlessRenderer } from "../../../src/infrastructure/headlessRenderer.js";
import type { HttpClient, HttpRequest, HttpResponse } from "../../../src/infrastructure/httpClient.js";
import { createDomainRateLimiter } from "../../../src/infrastructure/rateLimiter.js";
import {
  __robotsTest,
  createRobotsChecker,
  isPathAllowed,
  parseRobotsTxt,
  productToken,
  ROBOTS_MAX_BYTES,
  ROBOTS_UNREACHABLE_TTL_SECONDS,
} from "../../../src/infrastructure/robotsChecker.js";
import { createSerpProvider } from "../../../src/infrastructure/serpProvider.js";
import { ErrorCodes } from "../../../src/utils/errors.js";
import type { LookupFn } from "../../../src/utils/validators.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const UA = "mcp-server-competitor-content/1.1 (+https://github.com/dinesh7wd/mcp-server-competitor-content)";
const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

function httpReturning(
  impl: (req: HttpRequest) => Partial<HttpResponse> | Promise<Partial<HttpResponse>>,
): { http: HttpClient; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async (req: HttpRequest) => ({
    status: 200,
    body: "",
    headers: {},
    finalUrl: req.url,
    redirectCount: 0,
    ...(await impl(req)),
  }));
  return { http: { request }, request };
}

function config(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...process.env, RATE_LIMIT_DELAY_MS: "0", ...env });
}

describe("robots parsing", () => {
  it("applies shared rules to multi-agent groups", () => {
    const groups = parseRobotsTxt("User-agent: googlebot\nUser-agent: bingbot\nDisallow: /secret\n");
    expect(isPathAllowed(groups, "googlebot", "/secret")).toBe(false);
    expect(isPathAllowed(groups, "bingbot", "/secret")).toBe(false);
    expect(isPathAllowed(groups, "googlebot", "/ok")).toBe(true);
  });

  it("starts a new group after rules and ignores rules before any user-agent", () => {
    const groups = parseRobotsTxt(
      "Disallow: /orphan\nUser-agent: a\nDisallow: /x\nUser-agent: b\nAllow: /y\nUser-agent: c\nUser-agent: d\nDisallow: /z\n",
    );
    expect(groups.map((g) => g.agents)).toEqual([["a"], ["b"], ["c", "d"]]);
    expect(groups[2]?.disallows).toEqual(["/z"]);
  });

  it("merges every group for the same agent (RFC 9309 §2.2.1)", () => {
    const groups = parseRobotsTxt("User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /b\n");
    expect(isPathAllowed(groups, UA, "/a")).toBe(false);
    expect(isPathAllowed(groups, UA, "/b")).toBe(false);
    expect(isPathAllowed(groups, UA, "/c")).toBe(true);
  });

  it("matches the product token only, not substrings of the full UA", () => {
    const groups = parseRobotsTxt(
      "User-agent: github\nDisallow: /\n\nUser-agent: content\nDisallow: /\n\nUser-agent: *\nAllow: /\n",
    );
    expect(isPathAllowed(groups, UA, "/page")).toBe(true);
    expect(productToken(UA)).toBe("mcp-server-competitor-content");
  });

  it("prefers our token's groups over * and accepts versioned agent lines", () => {
    const groups = parseRobotsTxt(
      "User-agent: *\nDisallow: /\n\nUser-agent: MCP-Server-Competitor-Content/2.0\nDisallow: /private\n",
    );
    expect(isPathAllowed(groups, UA, "/public")).toBe(true);
    expect(isPathAllowed(groups, UA, "/private/x")).toBe(false);
  });

  it("skips empty user-agent lines", () => {
    const groups = parseRobotsTxt("User-agent:\nDisallow: /\n");
    expect(groups).toEqual([]);
    expect(isPathAllowed(groups, UA, "/x")).toBe(true);
  });

  it("matches paths case-sensitively", () => {
    const groups = parseRobotsTxt("User-agent: *\nDisallow: /Private\n");
    expect(isPathAllowed(groups, UA, "/private")).toBe(true);
    expect(isPathAllowed(groups, UA, "/Private/doc")).toBe(false);
  });

  it("honors * and $ wildcards and escapes regex characters", () => {
    const groups = parseRobotsTxt("User-agent: *\nDisallow: /*.pdf$\nDisallow: /a+b$c\nAllow: /\n");
    expect(isPathAllowed(groups, "bot", "/file.pdf")).toBe(false);
    expect(isPathAllowed(groups, "bot", "/file.pdf?x=1")).toBe(true);
    expect(isPathAllowed(groups, "bot", "/a+b$c")).toBe(false);
    expect(isPathAllowed(groups, "bot", "/aab")).toBe(true);
  });

  it("lets a longer allow win and treats empty Disallow as no rule", () => {
    const rules = __robotsTest.parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/public\nDisallow:\n", "bot");
    expect(__robotsTest.pathAllowed("/a/x", rules)).toBe(false);
    expect(__robotsTest.pathAllowed("/a/public", rules)).toBe(true);
    expect(__robotsTest.pathAllowed("", rules)).toBe(true);
  });

  it("allows everything when no group applies", () => {
    expect(isPathAllowed(parseRobotsTxt("User-agent: other\nDisallow: /\n"), UA, "/x")).toBe(true);
  });
});

describe("robots checker", () => {
  it("caches rulesets and requests truncated bodies", async () => {
    const { http, request } = httpReturning(() => ({ body: "User-agent: *\nDisallow: /private\n" }));
    const robots = createRobotsChecker(http, config({ RESPECT_ROBOTS_TXT: "true" }), new LruCache(10, 60));
    expect(await robots.isAllowed("https://ex.com/ok")).toBe(true);
    expect(await robots.isAllowed("https://ex.com/private/x")).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      url: "https://ex.com/robots.txt",
      maxBodyBytes: ROBOTS_MAX_BYTES,
      truncateBody: true,
    });
  });

  it("denies on 5xx, allows on 4xx", async () => {
    const cfg = config({ RESPECT_ROBOTS_TXT: "true" });
    const five = createRobotsChecker(httpReturning(() => ({ status: 503 })).http, cfg, new LruCache(10, 60));
    expect(await five.isAllowed("https://a.com/x")).toBe(false);
    for (const status of [401, 403, 404, 410]) {
      const four = createRobotsChecker(httpReturning(() => ({ status })).http, cfg, new LruCache(10, 60));
      expect(await four.isAllowed("https://a.com/x")).toBe(true);
    }
  });

  it("denies unreachable robots.txt only for a short TTL", async () => {
    const cache = new LruCache(10, 60);
    const setSpy = vi.spyOn(cache, "set");
    const { http } = httpReturning(() => {
      throw new Error("ECONNRESET");
    });
    const robots = createRobotsChecker(http, config({ RESPECT_ROBOTS_TXT: "true" }), cache);
    expect(await robots.isAllowed("https://down.com/x")).toBe(false);
    expect(setSpy).toHaveBeenCalledWith(
      "robots:https://down.com/robots.txt",
      expect.objectContaining({ status: "deny_all" }),
      ROBOTS_UNREACHABLE_TTL_SECONDS,
    );
  });

  it("returns false for invalid URLs and true when disabled", async () => {
    const { http, request } = httpReturning(() => ({}));
    const on = createRobotsChecker(http, config({ RESPECT_ROBOTS_TXT: "true" }), new LruCache(10, 60));
    expect(await on.isAllowed("not a url")).toBe(false);
    const off = createRobotsChecker(http, config({ RESPECT_ROBOTS_TXT: "false" }), new LruCache(10, 60));
    expect(await off.isAllowed("https://a.com/")).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("HTML parsing", () => {
  it("treats only true zero values as hidden", () => {
    expect(isHiddenStyle("font-size:0.875rem")).toBe(false);
    expect(isHiddenStyle("opacity: 0.8")).toBe(false);
    expect(isHiddenStyle("font-size: 10px")).toBe(false);
    expect(isHiddenStyle("font-size:0")).toBe(true);
    expect(isHiddenStyle("color:red; font-size: 0px !important")).toBe(true);
    expect(isHiddenStyle("opacity:0.0;")).toBe(true);
    expect(isHiddenStyle("opacity: .0")).toBe(true);
    expect(isHiddenStyle("display: none")).toBe(true);
    expect(isHiddenStyle("visibility:hidden")).toBe(true);
  });

  it("keeps visible small or translucent text and drops hidden text", () => {
    const page = parseHtmlToPage(
      `<html><body>
        <p style="font-size:0.875rem">Small visible</p>
        <p style="opacity: 0.8">Translucent visible</p>
        <p style="opacity:0">Invisible spam</p>
        <p hidden>Hidden attr</p>
        <p aria-hidden="true">Aria hidden</p>
      </body></html>`,
      "https://ex.com/",
      "https://ex.com/",
      false,
      10_000,
    );
    expect(page.bodyText).toContain("Small visible");
    expect(page.bodyText).toContain("Translucent visible");
    expect(page.bodyText).not.toMatch(/Invisible|Hidden attr|Aria hidden/);
  });

  it("detects JSON-LD (incl. @graph and type arrays) and never keeps HTML", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@graph":[{"@type":["Article","NewsArticle"]},{"@type":"Person"}]}</script>
      <script type="application/ld+json">not json</script>
      </head><body><p>Hello world content here</p></body></html>`;
    const page = parseHtmlToPage(html, "https://ex.com/", "https://ex.com/", false, 10_000);
    expect(page.schemaTypes).toEqual(["Article", "NewsArticle", "Person"]);
    expect(page.hasSchema).toBe(true);
    expect(page.html).toBe("");
  });

  it("counts only http(s) links and ignores javascript:/mailto:/tel:", () => {
    const html = `<html><body>
      <a href="https://www.ex.com/a">a</a><a href="/rel">r</a><a href="#top">t</a>
      <a href="https://other.com/b">b</a><a href="javascript:void(0)">j</a>
      <a href="mailto:x@y.z">m</a><a href="tel:123">t</a><a href="http://[bad">bad</a>
      </body></html>`;
    const page = parseHtmlToPage(html, "https://ex.com/", "https://www.ex.com/", false, 10_000);
    expect(page.internalLinks).toBe(2);
    expect(page.externalLinks).toBe(1);
    expect(page.outboundHosts).toEqual(["other.com"]);
  });

  it("falls back to og:description when the meta description is empty", () => {
    const page = parseHtmlToPage(
      `<html><head><meta name="description" content="  "><meta property="og:description" content="OG text"></head><body></body></html>`,
      "https://ex.com/",
      "https://ex.com/",
      false,
      10_000,
    );
    expect(page.metaDescription).toBe("OG text");
  });

  it("counts words before truncation and flags truncated text", () => {
    const words = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
    const page = parseHtmlToPage(`<p>${words}</p>`, "https://ex.com/", "https://ex.com/", false, 100);
    expect(page.bodyText).toHaveLength(100);
    expect(page.textTruncated).toBe(true);
    expect(page.wordCount).toBe(500);
    expect(page.brandMentions).toEqual([]);
  });

  it("caps scrape_page bodyText at maxChars and reports truncation", () => {
    const page = parseHtmlToPage(`<p>${"a ".repeat(3000)}</p>`, "https://ex.com/", "https://ex.com/", false, 100_000);
    const capped = toScrapeToolResult(page, 1000);
    expect(capped.truncated).toBe(true);
    expect(String(capped.bodyText)).toContain("UNTRUSTED_WEB_CONTENT");
    expect(String(capped.bodyText).length).toBeLessThan(1100);
    expect(capped).not.toHaveProperty("html");
    expect(toScrapeToolResult(page).truncated).toBe(false);
  });
});

describe("content fetcher", () => {
  const thin = readFileSync(join(fixtures, "thin-spa.html"), "utf8");
  const rich = readFileSync(join(fixtures, "article.html"), "utf8");

  function fetcher(
    over: Partial<ContentFetcherDeps> & { env?: Record<string, string> } = {},
  ): ContentFetcher {
    const { env, ...deps } = over;
    return createContentFetcher({
      http: httpReturning(() => ({ body: rich })).http,
      cache: new LruCache(10, 60),
      robots: { isAllowed: async () => true },
      rateLimiter: createDomainRateLimiter(0),
      headless: { render: vi.fn().mockResolvedValue(rich) },
      config: config(env),
      lookup: publicLookup,
      ...deps,
    });
  }

  it("falls back to headless on thin SPA HTML", async () => {
    const headless: HeadlessRenderer = { render: vi.fn().mockResolvedValue(rich) };
    const f = fetcher({ http: httpReturning(() => ({ body: thin })).http, headless });
    const page = await f.fetchPage("https://example.com/spa");
    expect(page.usedHeadless).toBe(true);
    expect(page.bodyText.length).toBeGreaterThan(200);
  });

  it("keeps the static page when the headless fallback fails or is oversized", async () => {
    const failing: HeadlessRenderer = { render: vi.fn().mockRejectedValue(new Error("boom")) };
    const f1 = fetcher({ http: httpReturning(() => ({ body: thin })).http, headless: failing });
    expect((await f1.fetchPage("https://example.com/a")).usedHeadless).toBe(false);

    const huge: HeadlessRenderer = { render: vi.fn().mockResolvedValue(`<p>${"x".repeat(3000)}</p>`) };
    const f2 = fetcher({
      http: httpReturning(() => ({ body: thin })).http,
      headless: huge,
      env: { MAX_BODY_BYTES: "1000" },
    });
    expect((await f2.fetchPage("https://example.com/b")).usedHeadless).toBe(false);
  });

  it("uses the headless final URL when forced", async () => {
    const headless: HeadlessRenderer = {
      render: vi.fn().mockResolvedValue({ html: rich, finalUrl: "https://example.com/final" }),
    };
    const { http, request } = httpReturning(() => ({}));
    const page = await fetcher({ http, headless }).fetchPage("https://example.com/x", { forceHeadless: true });
    expect(page.finalUrl).toBe("https://example.com/final");
    expect(page.usedHeadless).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("reports SSRF_BLOCKED (not ROBOTS_DISALLOWED) for private URLs", async () => {
    const robots = { isAllowed: vi.fn(async () => false) };
    const f = fetcher({ robots, env: { RESPECT_ROBOTS_TXT: "true" } });
    await expect(f.fetchPage("http://127.0.0.1/admin")).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
    expect(robots.isAllowed).not.toHaveBeenCalled();
  });

  it("enforces robots.txt for the request and for cross-host redirect targets", async () => {
    const blocked = fetcher({ robots: { isAllowed: async () => false }, env: { RESPECT_ROBOTS_TXT: "true" } });
    await expect(blocked.fetchPage("https://a.com/x")).rejects.toMatchObject({
      code: ErrorCodes.RobotsDisallowed,
    });

    const robots = { isAllowed: vi.fn(async (u: string) => !u.startsWith("https://b.com")) };
    const redirecting = httpReturning(() => ({ body: rich, finalUrl: "https://b.com/landing" })).http;
    const f = fetcher({ robots, http: redirecting, env: { RESPECT_ROBOTS_TXT: "true" } });
    await expect(f.fetchPage("https://a.com/x")).rejects.toMatchObject({
      code: ErrorCodes.RobotsDisallowed,
    });
    expect(robots.isAllowed).toHaveBeenCalledWith("https://b.com/landing");
  });

  it("fails on HTTP errors and serves repeat requests from cache", async () => {
    const notFound = fetcher({ http: httpReturning(() => ({ status: 404 })).http });
    await expect(notFound.fetchPage("https://a.com/missing")).rejects.toMatchObject({
      code: ErrorCodes.ScrapeFail,
    });

    const { http, request } = httpReturning(() => ({ body: rich }));
    const f = fetcher({ http });
    await f.fetchPage("https://a.com/p");
    await f.fetchPage("https://a.com/p");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("rate limiter", () => {
  it("spaces concurrent calls for the same domain", async () => {
    const limiter = createDomainRateLimiter(40);
    const start = Date.now();
    await Promise.all([limiter.wait("a.com"), limiter.wait("a.com"), limiter.wait("a.com")]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(75);
  });

  it("does not delay different domains", async () => {
    const limiter = createDomainRateLimiter(200);
    const start = Date.now();
    await Promise.all(["a.com", "b.com", "c.com"].map((d) => limiter.wait(d)));
    expect(Date.now() - start).toBeLessThan(150);
  });

  it("prunes stale domains once the map grows large", async () => {
    const limiter = createDomainRateLimiter(0);
    for (let i = 0; i < 1005; i += 1) await limiter.wait(`d${i}.com`);
    await expect(limiter.wait("d0.com")).resolves.toBeUndefined();
  });
});

describe("serp provider", () => {
  const serpConfig = (): AppConfig =>
    config({ SERP_PROVIDER: "serpapi", SERP_API_KEY: "SECRET", SERP_API_REGION: "us" });

  it("fails when unconfigured", async () => {
    const cfg = loadConfig({ ...process.env, SERP_PROVIDER: undefined, SERP_API_KEY: undefined });
    const serp = createSerpProvider({ request: vi.fn() } as unknown as HttpClient, cfg);
    await expect(serp.getSerpFeatures("running shoes")).rejects.toMatchObject({
      code: ErrorCodes.SerpUnconfigured,
    });
  });

  it("parses organic results, PAA, related searches and videos", async () => {
    const body = JSON.stringify({
      organic_results: [
        { position: 1, title: "A", link: "https://a.com", snippet: "s" },
        { title: "B", link: "https://b.com" },
        { title: "no link" },
      ],
      related_questions: [{ question: "Why?" }, {}],
      related_searches: [{ query: "shoes sale" }],
      inline_videos: [{}],
    });
    const { http, request } = httpReturning(() => ({ body }));
    const out = await createSerpProvider(http, serpConfig()).getSerpFeatures("shoes", { region: "in" });
    expect(out.organic).toEqual([
      { position: 1, title: "A", link: "https://a.com", snippet: "s" },
      { position: 2, title: "B", link: "https://b.com", snippet: "" },
    ]);
    expect(out).toMatchObject({ peopleAlsoAsk: ["Why?"], relatedSearches: ["shoes sale"], hasVideoCarousel: true });
    expect(String(request.mock.calls[0]?.[0].url)).toContain("gl=in");
  });

  it("handles empty payloads", async () => {
    const out = await createSerpProvider(httpReturning(() => ({ body: "null" })).http, serpConfig()).getSerpFeatures("q1");
    expect(out).toMatchObject({ organic: [], peopleAlsoAsk: [], relatedSearches: [], hasVideoCarousel: false });
  });

  it("maps HTTP, JSON and network failures to SERP_FAIL without leaking the key", async () => {
    const cfg = serpConfig();
    await expect(
      createSerpProvider(httpReturning(() => ({ status: 401 })).http, cfg).getSerpFeatures("q1"),
    ).rejects.toMatchObject({ code: ErrorCodes.SerpFail });
    await expect(
      createSerpProvider(httpReturning(() => ({ body: "<html>" })).http, cfg).getSerpFeatures("q1"),
    ).rejects.toThrow("invalid JSON");
    const failing = httpReturning(() => {
      throw new Error("boom https://serpapi.com/search.json?api_key=SECRET");
    }).http;
    const err = await createSerpProvider(failing, cfg).getSerpFeatures("q1").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: ErrorCodes.SerpFail });
    expect(String((err as Error).message)).not.toContain("SECRET");
  });
});

describe("cache and config", () => {
  it("expires entries, evicts the oldest, and clears", () => {
    const cache = new LruCache(2, 60);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    expect(cache.get("a")).toBeUndefined();
    now.mockRestore();
    cache.set("a", 1);
    cache.set("a", 2);
    expect(cache.get("a")).toBe(2);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
  });

  it("rejects removed providers and invalid env", () => {
    expect(() => loadConfig({ SERP_PROVIDER: "dataforseo" })).toThrow(/not supported/);
    expect(() => loadConfig({ HTTP_RETRIES: "99" })).toThrow(/Invalid environment/);
    expect(loadConfig({ SERP_PROVIDER: "serpapi", SERP_API_KEY: "k" })).toMatchObject({
      serpProvider: "serpapi",
      serpApiKey: "k",
    });
  });

  it("defaults the user agent to the package version", () => {
    expect(loadConfig({}).userAgent).toContain("/1.1 ");
  });
});
