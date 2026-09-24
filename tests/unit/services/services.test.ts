import { describe, expect, it, vi } from "vitest";
import { createServices } from "../../../src/services/index.js";
import type { ContentFetcher, ScrapedPage } from "../../../src/infrastructure/contentFetcher.js";
import type { SerpProvider } from "../../../src/infrastructure/serpProvider.js";
import { toCleanContent } from "../../../src/engines/scraperEngine.js";
import { multiHeadingCompare } from "../../../src/engines/headingDiffEngine.js";

function page(over: Partial<ScrapedPage> = {}): ScrapedPage {
  return {
    url: "https://a.com",
    finalUrl: "https://a.com",
    title: "Title",
    metaDescription: "Short",
    headings: [{ level: 1, text: "H" }],
    bodyText: "alpha beta gamma delta epsilon zeta eta theta running shoes training marathon cushion",
    html: "<p>x</p>",
    wordCount: 12,
    internalLinks: 0,
    externalLinks: 0,
    images: 0,
    hasSchema: false,
    schemaTypes: [],
    brandMentions: [],
    outboundHosts: [],
    usedHeadless: false,
    ...over,
  };
}

describe("services", () => {
  const fetcher: ContentFetcher = {
    fetchPage: vi.fn(async (url) => page({ url, finalUrl: url, title: `T-${url}` })),
  };
  const serp: SerpProvider = {
    getSerpFeatures: vi.fn(async (query) => ({
      query,
      organic: [],
      peopleAlsoAsk: [],
      relatedSearches: [],
      hasVideoCarousel: false,
      provider: "serpapi",
    })),
  };
  const services = createServices(fetcher, serp);

  it("keywords from text", async () => {
    const res = (await services.keywords({
      text: "running shoes marathon cushioning training race footwear",
      topK: 5,
    })) as { keywords: unknown[] };
    expect(res.keywords.length).toBeGreaterThan(0);
  });

  it("readability and quality", async () => {
    const r = await services.readability({
      text: "This is a simple sentence. Another sentence follows for testing readability metrics carefully.",
    });
    expect(r).toHaveProperty("fleschReadingEase");
    const q = await services.quality({ url: "https://a.com" });
    expect(q).toHaveProperty("score");
  });

  it("gap with url yourContent", async () => {
    const res = (await services.gap({
      yourContent: { type: "url", value: "https://yours.com" },
      competitorUrls: ["https://comp.com"],
    })) as { gaps: unknown[] };
    expect(Array.isArray(res.gaps)).toBe(true);
  });

  it("returns partial results when one competitor fails", async () => {
    const mixedFetcher: ContentFetcher = {
      fetchPage: vi.fn(async (url) => {
        if (url.includes("bad")) throw new Error("ROBOTS_DISALLOWED: blocked");
        return page({ url, finalUrl: url, title: `T-${url}` });
      }),
    };
    const svc = createServices(mixedFetcher, serp);
    const res = (await svc.gap({
      yourContent: { type: "raw_text", value: "running shoes marathon cushion training race footwear content pad" },
      competitorUrls: ["https://good.com", "https://bad.com"],
    })) as { competitors: unknown[]; errors: { url: string }[] };
    expect(res.competitors).toHaveLength(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.url).toContain("bad");
  });

  it("headings compare", async () => {
    const res = await services.headings({ urls: ["https://a.com", "https://b.com"] });
    expect(res).toHaveProperty("pages");
  });

  it("serp and cluster", async () => {
    await expect(services.serp({ query: "shoes" })).resolves.toMatchObject({ provider: "serpapi" });
    const c = (await services.cluster({ urls: ["https://a.com", "https://b.com"], k: 2 })) as {
      clusters: unknown[];
    };
    expect(c.clusters.length).toBeGreaterThan(0);
  });
});

describe("scraperEngine helpers", () => {
  it("projects clean content and multi headings", () => {
    const p = page();
    expect(toCleanContent(p).title).toBe("Title");
    expect(multiHeadingCompare([{ url: p.url, headings: p.headings }])[0]?.headingCount).toBe(1);
  });
});
