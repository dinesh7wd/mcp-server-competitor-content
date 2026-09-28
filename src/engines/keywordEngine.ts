import { ngrams, tokenize } from "../utils/textHelpers.js";

export interface KeywordResult {
  readonly keywords: readonly { term: string; score: number }[];
  readonly bigrams: readonly { term: string; score: number }[];
  readonly tokenCount: number;
}

export type IdfMap = ReadonlyMap<string, number>;

function termFreq(tokens: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tokens) map.set(t, (map.get(t) ?? 0) + 1);
  return map;
}

/** Sublinear TF: strictly increasing in count, so frequent terms never rank below rare ones. */
export function sublinearTf(count: number): number {
  return count > 0 ? 1 + Math.log(count) : 0;
}

/**
 * Rank terms by sublinear TF. Rarity only enters through a corpus IDF map
 * (terms missing from the map get weight 1).
 */
function rankTerms(
  freq: Map<string, number>,
  topK: number,
  idf?: IdfMap,
): { term: string; score: number }[] {
  const ranked: { term: string; score: number }[] = [];
  for (const [term, count] of freq) {
    const score = sublinearTf(count) * (idf?.get(term) ?? 1);
    ranked.push({ term, score: Number(score.toFixed(4)) });
  }
  return ranked.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term)).slice(0, topK);
}

export function extractKeywords(text: string, topK = 15, idf?: IdfMap): KeywordResult {
  const tokens = tokenize(text);
  const uni = rankTerms(termFreq(tokens), topK, idf);
  const bi = rankTerms(termFreq(ngrams(tokens, 2)), Math.min(10, topK));
  return { keywords: uni, bigrams: bi, tokenCount: tokens.length };
}

/** Document frequency across a corpus → smoothed IDF map (always >= 1). */
export function buildIdf(texts: readonly string[]): Map<string, number> {
  const df = new Map<string, number>();
  const docs = texts.length || 1;
  for (const text of texts) {
    const seen = new Set(tokenize(text));
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [term, d] of df) {
    idf.set(term, Math.log(1 + docs / (1 + d)) + 1);
  }
  return idf;
}

/** TF-IDF vector using corpus IDF (falls back to TF-only if IDF missing). */
export function tfidfVectorWithIdf(text: string, idf?: IdfMap): Map<string, number> {
  const tokens = tokenize(text);
  const freq = termFreq(tokens);
  const N = tokens.length || 1;
  const vec = new Map<string, number>();
  for (const [term, count] of freq) {
    const tf = count / N;
    const w = idf?.get(term) ?? 1;
    vec.set(term, tf * w);
  }
  return vec;
}
