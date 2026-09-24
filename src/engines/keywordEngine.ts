import { ngrams, tokenize } from "../utils/textHelpers.js";

export interface KeywordResult {
  readonly keywords: readonly { term: string; score: number }[];
  readonly bigrams: readonly { term: string; score: number }[];
  readonly tokenCount: number;
}

function termFreq(tokens: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tokens) map.set(t, (map.get(t) ?? 0) + 1);
  return map;
}

/**
 * Single-document keyword ranking using BM25-style saturation so scores
 * do not flatten (50 vs 200 occurrences stay distinguishable).
 */
function rankTerms(freq: Map<string, number>, topK: number): { term: string; score: number }[] {
  const N = [...freq.values()].reduce((a, b) => a + b, 0) || 1;
  const avgdl = N;
  const k1 = 1.5;
  const b = 0.75;
  const ranked: { term: string; score: number }[] = [];
  for (const [term, count] of freq) {
    const tf = count;
    const denom = tf + k1 * (1 - b + b * (N / avgdl));
    const score = (tf * (k1 + 1)) / denom;
    // Length-normalized rarity boost: rarer within doc (lower df relative) gets slight boost via 1/sqrt(count)
    const boosted = score * (1 + Math.log(1 + N / count));
    ranked.push({ term, score: Number(boosted.toFixed(4)) });
  }
  return ranked.sort((a, b) => b.score - a.score || b.term.localeCompare(a.term)).slice(0, topK);
}

export function extractKeywords(text: string, topK = 15): KeywordResult {
  const tokens = tokenize(text);
  const uni = rankTerms(termFreq(tokens), topK);
  const bi = rankTerms(termFreq(ngrams(tokens, 2)), Math.min(10, topK));
  return { keywords: uni, bigrams: bi, tokenCount: tokens.length };
}

/** Document frequency across a corpus → IDF map. */
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
export function tfidfVectorWithIdf(text: string, idf?: Map<string, number>): Map<string, number> {
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

/** @deprecated Prefer tfidfVectorWithIdf with buildIdf for multi-doc similarity. */
export function tfidfVector(text: string): Map<string, number> {
  return tfidfVectorWithIdf(text);
}
