import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createAppServices } from "../../src/server.js";
import type { ContentFetcher, ScrapedPage } from "../../src/infrastructure/contentFetcher.js";
import type { SerpProvider } from "../../src/infrastructure/serpProvider.js";
import { toolRegistry } from "../../src/tools/index.js";
import { ErrorCodes } from "../../src/utils/errors.js";

function fakePage(over: Partial<ScrapedPage> = {}): ScrapedPage {
  return {
    url: "https://a.com",
    finalUrl: "https://a.com",
    title: "A",
    metaDescription: "A long enough meta description for quality scoring tests here",
    headings: [
      { level: 1, text: "Main" },
      { level: 2, text: "Sub" },
      { level: 2, text: "More" },
    ],
    bodyText:
      "Running shoes marathon cushioning training race day footwear research cadence durability stability shoes for long distances and beginners.",
    html: "<html></html>",
    wordCount: 40,
    internalLinks: 3,
    externalLinks: 1,
    images: 1,
    hasSchema: true,
    schemaTypes: ["Article"],
    brandMentions: [],
    outboundHosts: ["b.com"],
    usedHeadless: false,
    ...over,
  };
}

describe("tools integration", () => {
  const fetcher: ContentFetcher = {
    fetchPage: vi.fn(async (url: string) => fakePage({ url, finalUrl: url, title: url })),
  };
  const serp: SerpProvider = {
    getSerpFeatures: vi.fn(async (query: string) => ({
      query,
      organic: [{ title: "t", link: "https://x.com", snippet: "s" }],
      peopleAlsoAsk: ["q1"],
      relatedSearches: ["r1"],
      hasVideoCarousel: false,
      provider: "serpapi",
      featuredSnippet: "answer",
    })),
  };
  const config = loadConfig(process.env);
  const services = createAppServices(config, { fetcher, serp });

  function tool(name: string): (typeof toolRegistry)[number] {
    const t = toolRegistry.find((x) => x.name === name);
    if (!t) throw new Error(name);
    return t;
  }

  it("registers eight tools", () => {
    expect(toolRegistry).toHaveLength(8);
  });

  it("scrapes via service", async () => {
    const res = await tool("scrape_page").handler({ url: "https://a.com" }, services, config);
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain("bodyText");
    expect(res.content[0]?.text).toContain("UNTRUSTED_WEB_CONTENT");
    expect(res.content[0]?.text).not.toMatch(/"html":\s*"[^"]/);
  });

  it("runs gap analysis with raw_text", async () => {
    const res = await tool("content_gap_analysis").handler(
      {
        yourContent: {
          type: "raw_text",
          value: "My short article about local bakery marketing tips and social posts for cafes.",
        },
        competitorUrls: ["https://comp.com"],
      },
      services,
      config,
    );
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain("gaps");
  });

  it("returns SERP_PROVIDER_UNCONFIGURED when using real serp without keys", async () => {
    const env = { ...process.env };
    delete env.SERP_PROVIDER;
    delete env.SERP_API_KEY;
    const bare = createAppServices(loadConfig(env), { fetcher });
    const res = await tool("serp_features").handler({ query: "shoes" }, bare, config);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain(ErrorCodes.SerpUnconfigured);
  });

  it("clusters competitors", async () => {
    const res = await tool("cluster_competitors").handler(
      { urls: ["https://a.com", "https://b.com"], k: 2 },
      services,
      config,
    );
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain("clusters");
  });
});
