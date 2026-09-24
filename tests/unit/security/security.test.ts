import { describe, expect, it, vi } from "vitest";
import {
  assertSafeHttpUrl,
  isBlockedIp,
  isBlockedIpv4,
  isBlockedIpv6,
} from "../../../src/utils/validators.js";
import { redactSecrets, safeUrlForLog } from "../../../src/utils/redact.js";
import { ErrorCodes } from "../../../src/utils/errors.js";
import {
  parseHtmlToPage,
  extractHeadingsInOrder,
  extractVisibleText,
} from "../../../src/infrastructure/contentFetcher.js";
import {
  __robotsTest,
  parseRobotsTxt,
  isPathAllowed,
} from "../../../src/infrastructure/robotsChecker.js";
import * as cheerio from "cheerio";
import { extractKeywords } from "../../../src/engines/keywordEngine.js";
import { createHttpClient } from "../../../src/infrastructure/httpClient.js";

describe("SSRF validators", () => {
  it("blocks loopback, CGNAT, link-local, metadata IPv4", () => {
    expect(isBlockedIpv4("127.0.0.1")).toBe(true);
    expect(isBlockedIpv4("10.0.0.1")).toBe(true);
    expect(isBlockedIpv4("100.64.1.1")).toBe(true);
    expect(isBlockedIpv4("169.254.169.254")).toBe(true);
    expect(isBlockedIpv4("192.168.1.1")).toBe(true);
    expect(isBlockedIpv4("8.8.8.8")).toBe(false);
  });

  it("blocks IPv6 loopback, ULA, link-local, mapped, AWS IMDS", () => {
    expect(isBlockedIpv6("::1")).toBe(true);
    expect(isBlockedIpv6("fe80::1")).toBe(true);
    expect(isBlockedIpv6("fd00:ec2::254")).toBe(true);
    expect(isBlockedIpv6("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIpv6("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIp("[::1]")).toBe(true);
  });

  it("blocks localhost and metadata hostnames without DNS", async () => {
    await expect(assertSafeHttpUrl("http://localhost/admin")).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
    await expect(assertSafeHttpUrl("http://metadata.goog/")).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
    await expect(assertSafeHttpUrl("http://127.0.0.1/")).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
  });

  it("blocks DNS that resolves to private IP", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(
      assertSafeHttpUrl("https://evil.example/x", lookup),
    ).rejects.toMatchObject({ code: ErrorCodes.SsrfBlocked });
  });

  it("allows public DNS", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = await assertSafeHttpUrl("https://example.com/path", lookup);
    expect(url.hostname).toBe("example.com");
  });
});

describe("redact secrets", () => {
  it("strips api_key from URLs and messages", () => {
    const u = "https://serpapi.com/search.json?q=shoes&api_key=SECRET123&gl=us";
    expect(safeUrlForLog(u)).not.toContain("SECRET");
    expect(safeUrlForLog(u)).not.toContain("api_key=");
    expect(redactSecrets(`Timeout ${u}`)).toContain("REDACTED");
    expect(redactSecrets(`Timeout ${u}`)).not.toContain("SECRET123");
  });
});

describe("HTML extraction fixes", () => {
  it("detects JSON-LD before script removal", () => {
    const html = `<!doctype html><html><head>
      <script type="application/ld+json">{"@type":"Article","headline":"Hi"}</script>
      </head><body><p>Hello world content here</p></body></html>`;
    const page = parseHtmlToPage(html, "https://ex.com/", "https://ex.com/", false, 10000);
    expect(page.hasSchema).toBe(true);
    expect(page.schemaTypes).toContain("Article");
    expect(page.html).toBe("");
  });

  it("returns headings in document order", () => {
    const $ = cheerio.load(`<h1>A</h1><h2>B</h2><h1>C</h1><h3>D</h3>`);
    expect(extractHeadingsInOrder($).map((h) => h.text)).toEqual(["A", "B", "C", "D"]);
  });

  it("joins block elements with whitespace", () => {
    const $ = cheerio.load(`<div>alpha</div><div>beta</div><p>gamma</p>`);
    const text = extractVisibleText($);
    expect(text).toMatch(/alpha/);
    expect(text).toMatch(/beta/);
    expect(text).not.toContain("alphabetagamma");
  });

  it("does not match Metadata as meta brand", () => {
    const page = parseHtmlToPage(
      `<html><body><p>Metadata about the product features</p></body></html>`,
      "https://ex.com/",
      "https://ex.com/",
      false,
      10000,
    );
    expect(page.brandMentions).not.toContain("meta");
  });

  it("updates link counts against finalUrl host", () => {
    const html = `<html><body>
      <a href="https://www.ex.com/a">a</a>
      <a href="https://other.com/b">b</a>
      </body></html>`;
    const page = parseHtmlToPage(html, "https://ex.com/", "https://www.ex.com/", false, 10000);
    expect(page.internalLinks).toBe(1);
    expect(page.externalLinks).toBe(1);
  });
});

describe("robots rewrite", () => {
  it("applies shared rules to multi-agent groups", () => {
    const groups = parseRobotsTxt(
      "User-agent: googlebot\nUser-agent: bingbot\nDisallow: /secret\n",
    );
    expect(isPathAllowed(groups, "googlebot", "/secret")).toBe(false);
    expect(isPathAllowed(groups, "bingbot", "/secret")).toBe(false);
    expect(isPathAllowed(groups, "googlebot", "/ok")).toBe(true);
  });

  it("honors * and $ wildcards", () => {
    const groups = parseRobotsTxt("User-agent: *\nDisallow: /*.pdf$\nAllow: /\n");
    expect(isPathAllowed(groups, "bot", "/file.pdf")).toBe(false);
    expect(isPathAllowed(groups, "bot", "/file.pdf?x=1")).toBe(true);
  });

  it("allow wins when longer than disallow", () => {
    const rules = __robotsTest.parseRobots(
      "User-agent: *\nDisallow: /a\nAllow: /a/public\n",
      "bot",
    );
    expect(__robotsTest.pathAllowed("/a/x", rules)).toBe(false);
    expect(__robotsTest.pathAllowed("/a/public", rules)).toBe(true);
  });
});

describe("keyword scoring", () => {
  it("does not flatten 50 vs 200 occurrences", () => {
    const t50 = Array(50).fill("widget").join(" ") + " " + Array(50).fill("other").join(" ");
    const t200 = Array(200).fill("widget").join(" ") + " " + Array(50).fill("other").join(" ");
    const s50 = extractKeywords(t50, 5).keywords.find((k) => k.term === "widget")!.score;
    const s200 = extractKeywords(t200, 5).keywords.find((k) => k.term === "widget")!.score;
    expect(s200).toBeGreaterThan(s50);
  });
});

describe("http redirect re-validation", () => {
  it("rejects redirect to loopback", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1:9/admin" },
      }),
    ) as typeof fetch;
    try {
      const client = createHttpClient({ timeoutMs: 2000, retries: 0 });
      // First hop must pass DNS — mock public resolve by using literal public IP host... 
      // Use validate with injected flow: request with validateRedirects true;
      // hostname "example.com" would DNS-resolve in real env. Stub assert via IP that's public then redirect.
      await expect(
        client.request({
          url: "http://8.8.8.8/",
          timeoutMs: 1000,
          retries: 0,
          validateRedirects: true,
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.SsrfBlocked });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
