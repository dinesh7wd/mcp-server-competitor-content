import { describe, expect, it, vi } from "vitest";
import { createServices, FETCH_CONCURRENCY } from "../../../src/services/index.js";
import type { ContentFetcher, ScrapedPage } from "../../../src/infrastructure/contentFetcher.js";
import type { SerpFeatures, SerpProvider } from "../../../src/infrastructure/serpProvider.js";
import { ErrorCodes, McpError } from "../../../src/utils/errors.js";

function page(over: Partial<ScrapedPage> = {}): ScrapedPage {
  return {
    url: "https://a.com",
    finalUrl: "https://a.com",
    title: "Title",
    metaDescription: "Short",
    headings: [{ level: 1, text: "H" }],
    bodyText: "alpha beta gamma delta epsilon zeta eta theta running shoes training marathon cushion",
    textTruncated: false,
    html: "",
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

const serpResult = (query: string): SerpFeatures => ({
  query,
  organic: [],
  peopleAlsoAsk: [],
  relatedSearches: [],
  hasVideoCarousel: false,
  provider: "serpapi",
});

const serp: SerpProvider = { getSerpFeatures: vi.fn(async (query: string) => serpResult(query)) };

function fetcherFrom(bodies: Record<string, string>, failing: readonly string[] = []): ContentFetcher {
  return {
    fetchPage: vi.fn(async (url: string) => {
      if (failing.some((f) => url.includes(f))) {
        throw new McpError(ErrorCodes.RobotsDisallowed, "blocked");
      }
      return page({ url, finalUrl: url, title: `T-${url}`, bodyText: bodies[url] ?? page().bodyText });
    }),
  };
}

describe("services", () => {
  const fetcher = fetcherFrom({});
  const services = createServices(fetcher, serp);

  it("keywords from text and from a URL", async () => {
    const res = (await services.keywords({
      text: "running shoes marathon cushioning training race footwear",
      topK: 5,
    })) as { keywords: unknown[] };
    expect(res.keywords.length).toBeGreaterThan(0);
    const fromUrl = (await services.keywords({ url: "https://a.com", topK: 3 })) as { keywords: unknown[] };
    expect(fromUrl.keywords).toHaveLength(3);
  });

  it("readability from text and URL; quality without body text", async () => {
    const r = await services.readability({
      text: "This is a simple sentence. Another sentence follows for testing readability metrics carefully.",
    });
    expect(r).toHaveProperty("fleschReadingEase");
    expect(await services.readability({ url: "https://a.com" })).toHaveProperty("wordCount");
    const q = (await services.quality({ url: "https://a.com" })) as { score: number; clean: object };
    expect(q).toHaveProperty("score");
    expect(q.clean).not.toHaveProperty("bodyText");
    expect(JSON.stringify(q)).not.toContain("epsilon");
  });

  it("throws when neither url nor text is supplied", async () => {
    await expect(services.keywords({ topK: 3 })).rejects.toMatchObject({ code: ErrorCodes.InternalError });
  });

  it("caps scrape bodyText at maxChars", async () => {
    const long = createServices(fetcherFrom({ "https://a.com": "word ".repeat(5000) }), serp);
    const res = (await long.scrape({ url: "https://a.com", forceHeadless: false, maxChars: 500 })) as {
      bodyText: string;
      truncated: boolean;
    };
    expect(res.truncated).toBe(true);
    expect(res.bodyText.length).toBeLessThan(600);
  });

  it("maps fetcher errors to McpError", async () => {
    const svc = createServices(fetcherFrom({}, ["a.com"]), serp);
    await expect(svc.scrape({ url: "https://a.com", forceHeadless: false, maxChars: 1000 })).rejects.toMatchObject({
      code: ErrorCodes.RobotsDisallowed,
    });
    await expect(svc.quality({ url: "https://a.com" })).rejects.toBeInstanceOf(McpError);
  });

  it("does not report terms that appear anywhere in your text as gaps", async () => {
    const filler = Array.from({ length: 60 }, (_, j) => `topic${String.fromCharCode(97 + (j % 26))}${j}`)
      .map((w) => `${w} `.repeat(6))
      .join(" ");
    const yours = `${filler} cushion cushion cushion marathon`;
    const svc = createServices(
      fetcherFrom({ "https://c.com": "cushion ".repeat(5) + "marathon stability outsole outsole outsole" }),
      serp,
    );
    const res = (await svc.gap({
      yourContent: { type: "raw_text", value: yours },
      competitorUrls: ["https://c.com"],
    })) as { gaps: { term: string }[]; yourKeywordCount: number };
    const terms = res.gaps.map((g) => g.term);
    expect(terms).not.toContain("cushion");
    expect(terms).not.toContain("marathon");
    expect(terms).toEqual(expect.arrayContaining(["outsole", "stability"]));
    expect(res.yourKeywordCount).toBe(62);
  });

  it("gap with url yourContent, and reports your own fetch failure", async () => {
    const res = (await services.gap({
      yourContent: { type: "url", value: "https://yours.com" },
      competitorUrls: ["https://comp.com"],
    })) as { gaps: unknown[]; competitors: { headingDiff: { shared: string[] } }[] };
    expect(res.competitors[0]?.headingDiff.shared).toEqual(["H1:h"]);

    const failing = createServices(fetcherFrom({}, ["yours"]), serp);
    const failed = (await failing.gap({
      yourContent: { type: "url", value: "https://yours.com" },
      competitorUrls: ["https://comp.com"],
    })) as { errors: { url: string }[]; competitors: unknown[] };
    expect(failed.competitors).toEqual([]);
    expect(failed.errors[0]?.url).toBe("https://yours.com");
  });

  it("returns partial gap results when one competitor fails", async () => {
    const svc = createServices(fetcherFrom({}, ["bad"]), serp);
    const res = (await svc.gap({
      yourContent: { type: "raw_text", value: "running shoes marathon cushion training race footwear content pad" },
      competitorUrls: ["https://good.com", "https://bad.com"],
    })) as { competitors: unknown[]; errors: { url: string; error: string }[] };
    expect(res.competitors).toHaveLength(1);
    expect(res.errors).toEqual([{ url: "https://bad.com", error: "ROBOTS_DISALLOWED: blocked" }]);
  });

  it("headings compare with a partial failure", async () => {
    const svc = createServices(fetcherFrom({}, ["b.com"]), serp);
    const res = (await svc.headings({ urls: ["https://a.com", "https://b.com", "https://c.com"] })) as {
      pages: { url: string }[];
      errors: { url: string }[];
    };
    expect(res.pages.map((p) => p.url)).toEqual(["https://a.com", "https://c.com"]);
    expect(res.errors.map((e) => e.url)).toEqual(["https://b.com"]);
    expect(await services.headings({ urls: ["https://a.com", "https://b.com"] })).not.toHaveProperty("errors");
  });

  it("serp passes region through and maps provider errors", async () => {
    await expect(services.serp({ query: "shoes", region: "in" })).resolves.toMatchObject({ provider: "serpapi" });
    expect(serp.getSerpFeatures).toHaveBeenCalledWith("shoes", { region: "in" });
    const broken: SerpProvider = { getSerpFeatures: vi.fn().mockRejectedValue(new Error("down")) };
    await expect(createServices(fetcher, broken).serp({ query: "shoes" })).rejects.toBeInstanceOf(McpError);
  });

  it("clusters with partial failures and null similarity for singletons", async () => {
    const svc = createServices(
      fetcherFrom(
        {
          "https://a.com": "running shoes marathon cushion",
          "https://b.com": "running shoes marathon cushion",
          "https://c.com": "pasta tomato basil recipe",
        },
        ["d.com"],
      ),
      serp,
    );
    const res = (await svc.cluster({
      urls: ["https://a.com", "https://b.com", "https://c.com", "https://d.com"],
      k: 3,
    })) as { clusters: { urls: string[]; avgIntraSimilarity: number | null }[]; errors: unknown[] };
    expect(res.clusters).toHaveLength(2);
    expect(res.clusters.every((c) => c.urls.length > 0)).toBe(true);
    const single = res.clusters.find((c) => c.urls.length === 1);
    expect(single?.avgIntraSimilarity).toBeNull();
    expect(res.errors).toHaveLength(1);
  });

  it("needs two successful fetches to cluster", async () => {
    const svc = createServices(fetcherFrom({}, ["b.com"]), serp);
    const res = (await svc.cluster({ urls: ["https://a.com", "https://b.com"], k: 2 })) as {
      clusters: unknown[];
      note: string;
    };
    expect(res.clusters).toEqual([]);
    expect(res.note).toMatch(/at least 2/);
  });

  it(`fetches at most ${FETCH_CONCURRENCY} pages at a time`, async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: ContentFetcher = {
      fetchPage: async (url: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return page({ url, finalUrl: url });
      },
    };
    const urls = Array.from({ length: 8 }, (_, i) => `https://s${i}.com`);
    const res = (await createServices(slow, serp).headings({ urls })) as { pages: { url: string }[] };
    expect(peak).toBe(FETCH_CONCURRENCY);
    expect(res.pages.map((p) => p.url)).toEqual(urls);
  });
});
