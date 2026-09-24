import type { ScrapedPage } from "../infrastructure/contentFetcher.js";

export interface QualityScore {
  readonly score: number;
  readonly wordCount: number;
  readonly internalLinks: number;
  readonly externalLinks: number;
  readonly images: number;
  readonly hasSchema: boolean;
  readonly hasMetaDescription: boolean;
  readonly headingCount: number;
  readonly notes: readonly string[];
}

export function scoreQuality(page: ScrapedPage): QualityScore {
  let score = 0;
  const notes: string[] = [];
  if (page.wordCount >= 800) {
    score += 25;
    notes.push("Solid word count");
  } else if (page.wordCount >= 300) {
    score += 15;
    notes.push("Moderate word count");
  } else {
    notes.push("Thin content");
  }
  if (page.internalLinks >= 3) score += 15;
  else notes.push("Few internal links");
  if (page.images >= 1) score += 10;
  if (page.hasSchema) score += 15;
  else notes.push("No structured data detected");
  if (page.metaDescription.length >= 50) score += 15;
  else notes.push("Weak/missing meta description");
  if (page.headings.some((h) => h.level === 1)) score += 10;
  else notes.push("Missing H1");
  if (page.headings.filter((h) => h.level === 2).length >= 2) score += 10;
  return {
    score: Math.min(100, score),
    wordCount: page.wordCount,
    internalLinks: page.internalLinks,
    externalLinks: page.externalLinks,
    images: page.images,
    hasSchema: page.hasSchema,
    hasMetaDescription: page.metaDescription.length >= 50,
    headingCount: page.headings.length,
    notes,
  };
}
