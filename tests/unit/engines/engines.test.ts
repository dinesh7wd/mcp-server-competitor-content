import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import {
  buildIdf,
  extractKeywords,
  sublinearTf,
  tfidfVectorWithIdf,
} from "../../../src/engines/keywordEngine.js";
import { scoreReadability } from "../../../src/engines/readabilityEngine.js";
import {
  averagePairwiseSimilarity,
  clusterTexts,
  clusterVectors,
  cosineSimilarity,
  MAX_CLUSTER_VECTOR_TERMS,
  similarityFromTexts,
  topTerms,
} from "../../../src/engines/similarityEngine.js";
import { countSyllables } from "../../../src/utils/textHelpers.js";
import { diffHeadings, multiHeadingCompare } from "../../../src/engines/headingDiffEngine.js";
import { scoreQuality } from "../../../src/engines/qualityEngine.js";
import { toCleanContent } from "../../../src/engines/scraperEngine.js";
import type { ScrapedPage } from "../../../src/infrastructure/contentFetcher.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");

function pageFromHtml(html: string): ScrapedPage {
  const $ = cheerio.load(html);
  $("script,style").remove();
  const bodyText = $("article").text().replace(/\s+/g, " ").trim();
  const headings: { level: number; text: string }[] = [];
  for (let level = 1; level <= 6; level += 1) {
    $(`h${level}`).each((_, el) => {
      headings.push({ level, text: $(el).text().trim() });
    });
  }
  return {
    url: "https://example.com",
    finalUrl: "https://example.com",
    title: $("title").text(),
    metaDescription: $('meta[name="description"]').attr("content") || "",
    headings,
    bodyText,
    textTruncated: false,
    html: "",
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

function repeat(word: string, n: number): string {
  return Array(n).fill(word).join(" ");
}

/** 60× main term, 45 filler terms ×4, 300 singletons — the case that broke the old scorer. */
function realisticDoc(): string {
  const parts = [repeat("marathon", 60)];
  for (let j = 0; j < 45; j += 1) {
    parts.push(repeat(`filler${String.fromCharCode(97 + (j % 26))}${String.fromCharCode(97 + Math.floor(j / 26))}`, 4));
  }
  for (let s = 0; s < 300; s += 1) parts.push(`single${s.toString(36)}x`);
  return parts.join(" ");
}

describe("keyword engine", () => {
  const html = readFileSync(join(fixtures, "article.html"), "utf8");
  const page = pageFromHtml(html);

  it("extracts keywords from the fixture", () => {
    const kw = extractKeywords(page.bodyText, 10);
    expect(kw.keywords.length).toBeGreaterThan(0);
    expect(kw.tokenCount).toBeGreaterThan(10);
  });

  it("scores strictly increase with count (non-stopword filler)", () => {
    const score = (n: number): number =>
      extractKeywords(`${repeat("widget", n)} ${repeat("gadget", 50)}`, 5).keywords.find(
        (k) => k.term === "widget",
      )!.score;
    const counts = [1, 2, 5, 10, 50, 200, 500];
    const scores = counts.map(score);
    for (let i = 1; i < scores.length; i += 1) expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
    expect(sublinearTf(0)).toBe(0);
  });

  it("ranks a dominant term above a singleton", () => {
    const kw = extractKeywords(`${repeat("alpha", 5000)} beta`, 5).keywords;
    expect(kw[0]?.term).toBe("alpha");
  });

  it("ranks the 60× term first in the realistic document", () => {
    const kw = extractKeywords(realisticDoc(), 40).keywords;
    expect(kw[0]?.term).toBe("marathon");
  });

  it("applies rarity only through a corpus IDF", () => {
    const docs = ["shoes shoes shoes cushion", "shoes shoes shoes pasta", "shoes shoes shoes basil"];
    const idf = buildIdf(docs);
    const plain = extractKeywords(docs[0]!, 5).keywords;
    expect(plain[0]?.term).toBe("shoes");
    const weighted = extractKeywords(docs[0]!, 5, idf).keywords;
    const shoes = weighted.find((k) => k.term === "shoes")!.score;
    const cushion = weighted.find((k) => k.term === "cushion")!.score;
    expect(idf.get("cushion")!).toBeGreaterThan(idf.get("shoes")!);
    expect(shoes).toBeGreaterThan(cushion);
    expect(buildIdf([]).size).toBe(0);
  });

  it("breaks score ties alphabetically", () => {
    expect(extractKeywords("zebra apple mango", 3).keywords.map((k) => k.term)).toEqual([
      "apple",
      "mango",
      "zebra",
    ]);
  });

  it("builds TF vectors without IDF", () => {
    expect(tfidfVectorWithIdf("alpha alpha beta").get("alpha")).toBeCloseTo(2 / 3);
    expect(tfidfVectorWithIdf("").size).toBe(0);
  });
});

describe("similarity and clustering", () => {
  const shoes = "running shoes marathon training cushion race footwear";
  const pasta = "pasta recipe tomato basil cooking";

  it("computes similarity and clusters distinct topics", () => {
    expect(similarityFromTexts(shoes, shoes)).toBeGreaterThan(0.9);
    const clusters = clusterTexts([shoes, pasta], 2);
    expect(clusters.map((c) => c.memberIndexes)).toEqual([[0], [1]]);
  });

  it("drops empty clusters when documents are duplicates", () => {
    expect(clusterTexts([shoes, shoes], 2)).toEqual([{ id: 0, memberIndexes: [0, 1] }]);
    const three = clusterTexts([shoes, shoes, pasta], 3);
    expect(three).toHaveLength(2);
    expect(three.every((c) => c.memberIndexes.length > 0)).toBe(true);
    expect(three.map((c) => c.id)).toEqual([0, 1]);
  });

  it("handles empty input and zero vectors", () => {
    expect(clusterVectors([], 3)).toEqual([]);
    expect(cosineSimilarity(new Map(), new Map([["a", 1]]))).toBe(0);
  });

  it("returns null average similarity for singletons", () => {
    const vectors = [shoes, shoes, pasta].map((t) => tfidfVectorWithIdf(t));
    expect(averagePairwiseSimilarity(vectors, [2])).toBeNull();
    expect(averagePairwiseSimilarity(vectors, [0, 1])).toBe(1);
  });
});

describe("other engines", () => {
  const page = pageFromHtml(readFileSync(join(fixtures, "article.html"), "utf8"));

  it("scores readability, including empty text", () => {
    const r = scoreReadability(page.bodyText);
    expect(r.wordCount).toBeGreaterThan(20);
    expect(Number.isFinite(r.fleschReadingEase)).toBe(true);
    expect(scoreReadability("")).toMatchObject({ sentenceCount: 0, wordCount: 0, fleschReadingEase: 0 });
  });

  it("keeps readability scores in range for degenerate input (M11)", () => {
    expect(scoreReadability("123 456 — 50% !!!")).toMatchObject({ wordCount: 0, fleschKincaidGrade: 0 });
    const tiny = scoreReadability("Go. Run. Sit. Eat.");
    expect(tiny.fleschReadingEase).toBeLessThanOrEqual(100);
    expect(tiny.fleschKincaidGrade).toBeGreaterThanOrEqual(0);
    expect(tiny.colemanLiau).toBeGreaterThanOrEqual(0);
    const dense = scoreReadability(`${"incomprehensibility internationalization ".repeat(40)}end`);
    expect(dense.fleschReadingEase).toBeGreaterThanOrEqual(0);
    expect(countSyllables("50%")).toBe(0);
    expect(countSyllables("table")).toBe(2);
  });

  it("caps clustering vectors to the heaviest terms", () => {
    const big = new Map(Array.from({ length: MAX_CLUSTER_VECTOR_TERMS + 50 }, (_, i) => [`t${i}`, i] as const));
    const capped = topTerms(big);
    expect(capped.size).toBe(MAX_CLUSTER_VECTOR_TERMS);
    expect(capped.has(`t${MAX_CLUSTER_VECTOR_TERMS + 49}`)).toBe(true);
    expect(capped.has("t0")).toBe(false);
  });

  it("diffs and lists headings", () => {
    const diff = diffHeadings(page.headings, [{ level: 1, text: "Other" }]);
    expect(diff.onlyInA.length).toBeGreaterThan(0);
    expect(diff.onlyInB).toEqual(["H1:other"]);
    expect(multiHeadingCompare([{ url: "u", headings: [{ level: 2, text: "X" }] }])[0]?.outline).toEqual([
      "H2: X",
    ]);
  });

  it("scores quality across word-count tiers", () => {
    expect(scoreQuality(page).score).toBeGreaterThan(0);
    const base = { ...page, headings: [{ level: 1, text: "A" }, { level: 2, text: "B" }, { level: 2, text: "C" }] };
    expect(scoreQuality({ ...base, wordCount: 900 }).notes).toContain("Solid word count");
    expect(scoreQuality({ ...base, wordCount: 400 }).notes).toContain("Moderate word count");
    const thin = scoreQuality({ ...base, wordCount: 10, headings: [], hasSchema: false, metaDescription: "" });
    expect(thin.notes).toEqual(expect.arrayContaining(["Thin content", "Missing H1"]));
  });

  it("projects clean content without body text", () => {
    const clean = toCleanContent(page);
    expect(clean).not.toHaveProperty("bodyText");
    expect(clean.title).toBe(page.title);
  });
});
