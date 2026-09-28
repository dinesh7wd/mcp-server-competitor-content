import type { ScrapedPage } from "../infrastructure/contentFetcher.js";

/** Summary projection without body text (full text is only available via scrape_page). */
export interface CleanContent {
  readonly title: string;
  readonly metaDescription: string;
  readonly headings: readonly { level: number; text: string }[];
  readonly wordCount: number;
}

/** Pure: ScrapedPage → clean content projection. */
export function toCleanContent(page: ScrapedPage): CleanContent {
  return {
    title: page.title,
    metaDescription: page.metaDescription,
    headings: page.headings,
    wordCount: page.wordCount,
  };
}
