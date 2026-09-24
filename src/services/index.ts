import type { ContentFetcher, ScrapedPage } from "../infrastructure/contentFetcher.js";
import type { SerpProvider } from "../infrastructure/serpProvider.js";
import { extractKeywords } from "../engines/keywordEngine.js";
import { diffHeadings, multiHeadingCompare } from "../engines/headingDiffEngine.js";
import { scoreReadability } from "../engines/readabilityEngine.js";
import { scoreQuality } from "../engines/qualityEngine.js";
import { clusterTexts, similarityFromTexts } from "../engines/similarityEngine.js";
import { toCleanContent } from "../engines/scraperEngine.js";
import { toMcpError } from "../utils/errors.js";
import type {
  ClusterCompetitorsInput,
  CompareHeadingsInput,
  ContentGapInput,
  ExtractKeywordsInput,
  QualityInput,
  ReadabilityInput,
  ScrapePageInput,
  SerpFeaturesInput,
} from "../utils/schemas.js";

export interface AppServices {
  scrape(input: ScrapePageInput): Promise<ScrapedPage>;
  keywords(input: ExtractKeywordsInput): Promise<unknown>;
  gap(input: ContentGapInput): Promise<unknown>;
  headings(input: CompareHeadingsInput): Promise<unknown>;
  readability(input: ReadabilityInput): Promise<unknown>;
  quality(input: QualityInput): Promise<unknown>;
  serp(input: SerpFeaturesInput): Promise<unknown>;
  cluster(input: ClusterCompetitorsInput): Promise<unknown>;
}

async function resolveText(
  fetcher: ContentFetcher,
  url?: string,
  text?: string,
): Promise<{ text: string; page?: ScrapedPage }> {
  if (text !== undefined) return { text };
  if (url === undefined) throw new Error("url or text required");
  const page = await fetcher.fetchPage(url);
  return { text: page.bodyText, page };
}

export function createServices(fetcher: ContentFetcher, serp: SerpProvider): AppServices {
  return {
    async scrape(input): Promise<ScrapedPage> {
      try {
        return await fetcher.fetchPage(input.url, { forceHeadless: input.forceHeadless });
      } catch (e) {
        throw toMcpError(e);
      }
    },
    async keywords(input) {
      try {
        const { text } = await resolveText(fetcher, input.url, input.text);
        return extractKeywords(text, input.topK);
      } catch (e) {
        throw toMcpError(e);
      }
    },
    async gap(input) {
      try {
        let yourText: string;
        let yourHeadings: { level: number; text: string }[] = [];
        if (input.yourContent.type === "url") {
          const page = await fetcher.fetchPage(input.yourContent.value);
          yourText = page.bodyText;
          yourHeadings = [...page.headings];
        } else {
          yourText = input.yourContent.value;
        }
        const yourKw = new Set(extractKeywords(yourText, 30).keywords.map((k) => k.term));
        const competitorReports = [];
        const missing = new Map<string, number>();
        for (const curl of input.competitorUrls) {
          const page = await fetcher.fetchPage(curl);
          const kw = extractKeywords(page.bodyText, 30);
          for (const k of kw.keywords) {
            if (!yourKw.has(k.term)) missing.set(k.term, (missing.get(k.term) ?? 0) + 1);
          }
          competitorReports.push({
            url: curl,
            title: page.title,
            wordCount: page.wordCount,
            topKeywords: kw.keywords.slice(0, 10),
            headingDiff: diffHeadings(yourHeadings, page.headings),
            similarity: Number(similarityFromTexts(yourText, page.bodyText).toFixed(4)),
          });
        }
        const gaps = [...missing.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 25)
          .map(([term, competitorHits]) => ({ term, competitorHits }));
        return { yourKeywordCount: yourKw.size, gaps, competitors: competitorReports };
      } catch (e) {
        throw toMcpError(e);
      }
    },
    async headings(input) {
      try {
        const pages: { url: string; headings: ScrapedPage["headings"] }[] = [];
        for (const url of input.urls) {
          const page = await fetcher.fetchPage(url);
          pages.push({ url, headings: page.headings });
        }
        return { pages: multiHeadingCompare(pages) };
      } catch (e) {
        throw toMcpError(e);
      }
    },
    async readability(input) {
      try {
        const { text } = await resolveText(fetcher, input.url, input.text);
        return scoreReadability(text);
      } catch (e) {
        throw toMcpError(e);
      }
    },
    async quality(input) {
      try {
        const page = await fetcher.fetchPage(input.url);
        return { ...scoreQuality(page), clean: toCleanContent(page) };
      } catch (e) {
        throw toMcpError(e);
      }
    },
    async serp(input) {
      try {
        return await serp.getSerpFeatures(input.query, {
          ...(input.region !== undefined ? { region: input.region } : {}),
        });
      } catch (e) {
        throw toMcpError(e);
      }
    },
    async cluster(input) {
      try {
        const pages: ScrapedPage[] = [];
        for (const url of input.urls) {
          pages.push(await fetcher.fetchPage(url));
        }
        const texts = pages.map((p) => p.bodyText);
        const clusters = clusterTexts(texts, input.k);
        return {
          clusters: clusters.map((c) => ({
            id: c.id,
            urls: c.memberIndexes.map((i) => pages[i]!.url),
            titles: c.memberIndexes.map((i) => pages[i]!.title),
          })),
        };
      } catch (e) {
        throw toMcpError(e);
      }
    },
  };
}
