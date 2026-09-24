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

function rankMap(freq: Map<string, number>, totalDocs = 1): { term: string; score: number }[] {
  const ranked: { term: string; score: number }[] = [];
  const N = [...freq.values()].reduce((a, b) => a + b, 0) || 1;
  for (const [term, count] of freq) {
    const tf = count / N;
    const idf = Math.log(1 + totalDocs / (1 + count));
    ranked.push({ term, score: Number((tf * idf * 100).toFixed(4)) });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

export function extractKeywords(text: string, topK = 15): KeywordResult {
  const tokens = tokenize(text);
  const uni = rankMap(termFreq(tokens)).slice(0, topK);
  const bi = rankMap(termFreq(ngrams(tokens, 2))).slice(0, Math.min(10, topK));
  return { keywords: uni, bigrams: bi, tokenCount: tokens.length };
}

/** Build TF-IDF style sparse vector for similarity (term → weight). */
export function tfidfVector(text: string): Map<string, number> {
  const tokens = tokenize(text);
  const freq = termFreq(tokens);
  const N = tokens.length || 1;
  const vec = new Map<string, number>();
  for (const [term, count] of freq) {
    vec.set(term, count / N);
  }
  return vec;
}
