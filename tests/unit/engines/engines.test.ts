import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { extractKeywords } from "../../../src/engines/keywordEngine.js";
import { scoreReadability } from "../../../src/engines/readabilityEngine.js";
import { clusterTexts, similarityFromTexts } from "../../../src/engines/similarityEngine.js";
import { diffHeadings } from "../../../src/engines/headingDiffEngine.js";
import { scoreQuality } from "../../../src/engines/qualityEngine.js";
import type { ScrapedPage } from "../../../src/infrastructure/contentFetcher.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");

function pageFromHtml(html: string): ScrapedPage {
  const $ = cheerio.load(html);
  $("script,style").remove();
  const bodyText = $("article").text().replace(/\s+/g, " ").trim();
  const headings: { level: number; text: string }[] = [];
  for (let level = 1; level <= 6; level += 1) {
    $(`h${level}`).each((_, el) => headings.push({ level, text: $(el).text().trim() }));
  }
  return {
    url: "https://example.com",
    finalUrl: "https://example.com",
    title: $("title").text(),
    metaDescription: $('meta[name="description"]').attr("content") || "",
    headings,
    bodyText,
    html,
    wordCount: bodyText.split(/\s+/).length,
    internalLinks: 1,
    externalLinks: 0,
    images: $("img").length,
    hasSchema: true,
    schemaTypes: ["Article"],
    brandMentions: ["amazon"],
    outboundHosts: [],
    usedHeadless: false,
  };
}

describe("engines", () => {
  const html = readFileSync(join(fixtures, "article.html"), "utf8");
  const page = pageFromHtml(html);

  it("extracts keywords", () => {
    const kw = extractKeywords(page.bodyText, 10);
    expect(kw.keywords.length).toBeGreaterThan(0);
    expect(kw.tokenCount).toBeGreaterThan(10);
  });

  it("scores readability", () => {
    const r = scoreReadability(page.bodyText);
    expect(r.wordCount).toBeGreaterThan(20);
    expect(Number.isFinite(r.fleschReadingEase)).toBe(true);
  });

  it("computes similarity and clusters", () => {
    expect(similarityFromTexts(page.bodyText, page.bodyText)).toBeGreaterThan(0.9);
    const clusters = clusterTexts([page.bodyText, "totally unrelated cooking recipes pasta"], 2);
    expect(clusters.length).toBe(2);
  });

  it("diffs headings", () => {
    const diff = diffHeadings(page.headings, [{ level: 1, text: "Other" }]);
    expect(diff.onlyInA.length).toBeGreaterThan(0);
  });

  it("scores quality", () => {
    const q = scoreQuality(page);
    expect(q.score).toBeGreaterThan(0);
  });
});
