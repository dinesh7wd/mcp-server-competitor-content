import type { ContentFetcher, ScrapedPage } from "../infrastructure/contentFetcher.js";
import { toScrapeToolResult } from "../infrastructure/contentFetcher.js";
import type { SerpProvider } from "../infrastructure/serpProvider.js";
import {
  buildIdf,
  extractKeywords,
  tfidfVectorWithIdf,
  type IdfMap,
} from "../engines/keywordEngine.js";
import { diffHeadings, multiHeadingCompare } from "../engines/headingDiffEngine.js";
import { scoreReadability } from "../engines/readabilityEngine.js";
import { scoreQuality } from "../engines/qualityEngine.js";
import {
  averagePairwiseSimilarity,
  clusterVectors,
  cosineSimilarity,
} from "../engines/similarityEngine.js";
import { toCleanContent } from "../engines/scraperEngine.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { toMcpError } from "../utils/errors.js";
import { tokenize } from "../utils/textHelpers.js";
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

interface FetchError {
  readonly url: string;
  readonly error: string;
}

interface FetchedPage {
  readonly url: string;
  readonly page: ScrapedPage;
}

interface YourContent {
  readonly text: string;
  readonly headings: readonly { level: number; text: string }[];
}

/** Max in-flight page fetches per tool call; per-host spacing is still enforced by the fetcher. */
export const FETCH_CONCURRENCY = 3;
const GAP_TOP_K = 30;
const GAP_MAX_RESULTS = 25;

async function resolveText(fetcher: ContentFetcher, url?: string, text?: string): Promise<string> {
  if (text !== undefined) return text;
  if (url === undefined) throw new Error("url or text required");
  return (await fetcher.fetchPage(url)).bodyText;
}

async function fetchOne(
  fetcher: ContentFetcher,
  url: string,
): Promise<{ ok: true; page: ScrapedPage } | { ok: false; error: FetchError }> {
  try {
    return { ok: true, page: await fetcher.fetchPage(url) };
  } catch (e) {
    const err = toMcpError(e);
    return { ok: false, error: { url, error: `${err.code}: ${err.message}` } };
  }
}

async function fetchAll(
  fetcher: ContentFetcher,
  urls: readonly string[],
): Promise<{ pages: FetchedPage[]; errors: FetchError[] }> {
  const outcomes = await mapWithConcurrency(urls, FETCH_CONCURRENCY, (u) => fetchOne(fetcher, u));
  const pages: FetchedPage[] = [];
  const errors: FetchError[] = [];
  outcomes.forEach((o, i) => {
    if (o.ok) pages.push({ url: urls[i]!, page: o.page });
    else errors.push(o.error);
  });
  return { pages, errors };
}

function withErrors<T extends object>(result: T, errors: readonly FetchError[]): T {
  return errors.length > 0 ? { ...result, errors } : result;
}

async function resolveYourContent(
  fetcher: ContentFetcher,
  input: ContentGapInput["yourContent"],
): Promise<{ ok: true; content: YourContent } | { ok: false; error: FetchError }> {
  if (input.type === "raw_text") return { ok: true, content: { text: input.value, headings: [] } };
  const result = await fetchOne(fetcher, input.value);
  if (!result.ok) return result;
  return { ok: true, content: { text: result.page.bodyText, headings: result.page.headings } };
}

type MissingTerms = Map<string, { hits: number; bestScore: number }>;

function recordMissing(missing: MissingTerms, term: string, score: number): void {
  const prev = missing.get(term);
  missing.set(term, {
    hits: (prev?.hits ?? 0) + 1,
    bestScore: Math.max(prev?.bestScore ?? 0, score),
  });
}

function rankGaps(missing: MissingTerms): { term: string; competitorHits: number; bestScore: number }[] {
  return [...missing.entries()]
    .sort((a, b) => b[1].hits - a[1].hits || b[1].bestScore - a[1].bestScore)
    .slice(0, GAP_MAX_RESULTS)
    .map(([term, v]) => ({ term, competitorHits: v.hits, bestScore: v.bestScore }));
}

function buildGapReport(yours: YourContent, pages: readonly FetchedPage[]): Record<string, unknown> {
  const yourTerms = new Set(tokenize(yours.text));
  const idf: IdfMap = buildIdf([yours.text, ...pages.map((p) => p.page.bodyText)]);
  const yourVector = tfidfVectorWithIdf(yours.text, idf);
  const missing: MissingTerms = new Map();

  const competitors = pages.map(({ url, page }) => {
    const kw = extractKeywords(page.bodyText, GAP_TOP_K, idf);
    for (const k of kw.keywords) {
      if (!yourTerms.has(k.term)) recordMissing(missing, k.term, k.score);
    }
    const similarity = cosineSimilarity(yourVector, tfidfVectorWithIdf(page.bodyText, idf));
    return {
      url,
      finalUrl: page.finalUrl,
      title: page.title,
      wordCount: page.wordCount,
      topKeywords: kw.keywords.slice(0, 10),
      headingDiff: diffHeadings(yours.headings, page.headings),
      similarity: Number(similarity.toFixed(4)),
    };
  });

  return { yourKeywordCount: yourTerms.size, gaps: rankGaps(missing), competitors };
}

function buildClusterReport(pages: readonly FetchedPage[], k: number): Record<string, unknown> {
  const texts = pages.map((p) => p.page.bodyText);
  const idf = buildIdf(texts);
  const vectors = texts.map((t) => tfidfVectorWithIdf(t, idf));
  const clusters = clusterVectors(vectors, k).map((c) => ({
    id: c.id,
    urls: c.memberIndexes.map((i) => pages[i]!.url),
    titles: c.memberIndexes.map((i) => pages[i]!.page.title),
    avgIntraSimilarity: averagePairwiseSimilarity(vectors, c.memberIndexes),
  }));
  return { clusters };
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw toMcpError(e);
  }
}

export function createServices(fetcher: ContentFetcher, serp: SerpProvider): AppServices {
  return {
    scrape: (input) =>
      guard(async () => {
        const page = await fetcher.fetchPage(input.url, { forceHeadless: input.forceHeadless });
        return toScrapeToolResult(page, input.maxChars);
      }),
    keywords: (input) =>
      guard(async () => extractKeywords(await resolveText(fetcher, input.url, input.text), input.topK)),
    gap: (input) =>
      guard(async () => {
        const yours = await resolveYourContent(fetcher, input.yourContent);
        if (!yours.ok) {
          return { yourKeywordCount: 0, gaps: [], competitors: [], errors: [yours.error] };
        }
        const { pages, errors } = await fetchAll(fetcher, input.competitorUrls);
        return withErrors(buildGapReport(yours.content, pages), errors);
      }),
    headings: (input) =>
      guard(async () => {
        const { pages, errors } = await fetchAll(fetcher, input.urls);
        const outlines = pages.map((p) => ({ url: p.url, headings: p.page.headings }));
        return withErrors({ pages: multiHeadingCompare(outlines) }, errors);
      }),
    readability: (input) =>
      guard(async () => scoreReadability(await resolveText(fetcher, input.url, input.text))),
    quality: (input) =>
      guard(async () => {
        const page = await fetcher.fetchPage(input.url);
        return { ...scoreQuality(page), clean: toCleanContent(page) };
      }),
    serp: (input) =>
      guard(() =>
        serp.getSerpFeatures(input.query, {
          ...(input.region !== undefined ? { region: input.region } : {}),
        }),
      ),
    cluster: (input) =>
      guard(async () => {
        const { pages, errors } = await fetchAll(fetcher, input.urls);
        if (pages.length < 2) {
          return { clusters: [], errors, note: "Need at least 2 successful page fetches" };
        }
        return withErrors(buildClusterReport(pages, input.k), errors);
      }),
  };
}
