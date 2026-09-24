import type { ContentFetcher, ScrapedPage } from "../infrastructure/contentFetcher.js";
import { toScrapeToolResult } from "../infrastructure/contentFetcher.js";
import type { SerpProvider } from "../infrastructure/serpProvider.js";
import { extractKeywords, buildIdf, tfidfVectorWithIdf } from "../engines/keywordEngine.js";
import { diffHeadings, multiHeadingCompare } from "../engines/headingDiffEngine.js";
import { scoreReadability } from "../engines/readabilityEngine.js";
import { scoreQuality } from "../engines/qualityEngine.js";
import { clusterTexts, cosineSimilarity, similarityFromTexts } from "../engines/similarityEngine.js";
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
  scrape(input: ScrapePageInput): Promise<unknown>;
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

async function fetchOne(
  fetcher: ContentFetcher,
  url: string,
): Promise<{ ok: true; page: ScrapedPage } | { ok: false; url: string; error: string }> {
  try {
    const page = await fetcher.fetchPage(url);
    return { ok: true, page };
  } catch (e) {
    const err = toMcpError(e);
    return { ok: false, url, error: `${err.code}: ${err.message}` };
  }
}

/** Gap: term must appear in competitor top-K with score above threshold and not in yours. */
const GAP_MIN_SCORE = 0.5;
const GAP_MIN_COMPETITOR_HITS = 1;

export function createServices(fetcher: ContentFetcher, serp: SerpProvider): AppServices {
  return {
    async scrape(input) {
      try {
        const page = await fetcher.fetchPage(input.url, {
          forceHeadless: input.forceHeadless,
        });
        return toScrapeToolResult(page);
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
        const errors: { url: string; error: string }[] = [];

        if (input.yourContent.type === "url") {
          const yours = await fetchOne(fetcher, input.yourContent.value);
          if (!yours.ok) {
            return {
              yourKeywordCount: 0,
              gaps: [],
              competitors: [],
              errors: [{ url: yours.url, error: yours.error }],
            };
          }
          yourText = yours.page.bodyText;
          yourHeadings = [...yours.page.headings];
        } else {
          yourText = input.yourContent.value;
        }

        const yourKw = extractKeywords(yourText, 40);
        const yourTerms = new Set(
          yourKw.keywords.filter((k) => k.score >= GAP_MIN_SCORE).map((k) => k.term),
        );
        // Also treat any token that appears >= 2 times in your text as present
        for (const k of yourKw.keywords) {
          if (k.term) yourTerms.add(k.term);
        }

        const competitorReports: unknown[] = [];
        const missing = new Map<string, { hits: number; bestScore: number }>();

        for (const curl of input.competitorUrls) {
          const result = await fetchOne(fetcher, curl);
          if (!result.ok) {
            errors.push({ url: result.url, error: result.error });
            continue;
          }
          const page = result.page;
          const kw = extractKeywords(page.bodyText, 30);
          for (const k of kw.keywords) {
            if (k.score < GAP_MIN_SCORE) continue;
            if (yourTerms.has(k.term)) continue;
            const prev = missing.get(k.term);
            if (!prev) missing.set(k.term, { hits: 1, bestScore: k.score });
            else {
              missing.set(k.term, {
                hits: prev.hits + 1,
                bestScore: Math.max(prev.bestScore, k.score),
              });
            }
          }
          competitorReports.push({
            url: curl,
            finalUrl: page.finalUrl,
            title: page.title,
            wordCount: page.wordCount,
            topKeywords: kw.keywords.slice(0, 10),
            headingDiff: diffHeadings(yourHeadings, page.headings),
            similarity: Number(similarityFromTexts(yourText, page.bodyText).toFixed(4)),
          });
        }

        const gaps = [...missing.entries()]
          .filter(([, v]) => v.hits >= GAP_MIN_COMPETITOR_HITS)
          .sort((a, b) => b[1].hits - a[1].hits || b[1].bestScore - a[1].bestScore)
          .slice(0, 25)
          .map(([term, v]) => ({
            term,
            competitorHits: v.hits,
            bestScore: v.bestScore,
          }));

        return {
          yourKeywordCount: yourTerms.size,
          gaps,
          competitors: competitorReports,
          ...(errors.length > 0 ? { errors } : {}),
        };
      } catch (e) {
        throw toMcpError(e);
      }
    },
    async headings(input) {
      try {
        const pages: { url: string; headings: ScrapedPage["headings"] }[] = [];
        const errors: { url: string; error: string }[] = [];
        for (const url of input.urls) {
          const result = await fetchOne(fetcher, url);
          if (!result.ok) {
            errors.push({ url: result.url, error: result.error });
            continue;
          }
          pages.push({ url, headings: result.page.headings });
        }
        return {
          pages: multiHeadingCompare(pages),
          ...(errors.length > 0 ? { errors } : {}),
        };
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
        const errors: { url: string; error: string }[] = [];
        for (const url of input.urls) {
          const result = await fetchOne(fetcher, url);
          if (!result.ok) {
            errors.push({ url: result.url, error: result.error });
            continue;
          }
          pages.push(result.page);
        }
        if (pages.length < 2) {
          return { clusters: [], errors, note: "Need at least 2 successful page fetches" };
        }
        const texts = pages.map((p) => p.bodyText);
        const idf = buildIdf(texts);
        const vectors = texts.map((t) => tfidfVectorWithIdf(t, idf));
        // Use corpus IDF vectors for clustering via similarityEngine helper
        const clusters = clusterTexts(texts, input.k, idf);
        return {
          clusters: clusters.map((c) => ({
            id: c.id,
            urls: c.memberIndexes.map((i) => pages[i]!.url),
            titles: c.memberIndexes.map((i) => pages[i]!.title),
            avgIntraSimilarity: (() => {
              const idxs = c.memberIndexes;
              if (idxs.length < 2) return 1;
              let sum = 0;
              let n = 0;
              for (let i = 0; i < idxs.length; i += 1) {
                for (let j = i + 1; j < idxs.length; j += 1) {
                  sum += cosineSimilarity(vectors[idxs[i]!]!, vectors[idxs[j]!]!);
                  n += 1;
                }
              }
              return n ? Number((sum / n).toFixed(4)) : 1;
            })(),
          })),
          ...(errors.length > 0 ? { errors } : {}),
        };
      } catch (e) {
        throw toMcpError(e);
      }
    },
  };
}
