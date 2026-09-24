import type { ScrapedPage } from "../infrastructure/contentFetcher.js";

export interface CleanContent {
  readonly title: string;
  readonly metaDescription: string;
  readonly headings: readonly { level: number; text: string }[];
  readonly bodyText: string;
  readonly wordCount: number;
}

/** Pure: ScrapedPage → clean content projection. */
export function toCleanContent(page: ScrapedPage): CleanContent {
  return {
    title: page.title,
    metaDescription: page.metaDescription,
    headings: page.headings,
    bodyText: page.bodyText,
    wordCount: page.wordCount,
  };
}
