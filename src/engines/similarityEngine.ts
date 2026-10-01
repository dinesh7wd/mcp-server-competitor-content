import { buildIdf, tfidfVectorWithIdf, type IdfMap } from "./keywordEngine.js";

export type TermVector = ReadonlyMap<string, number>;

const DUPLICATE_EPSILON = 1e-9;
/** Clustering keeps each document's heaviest terms only, so k-means cost does not grow with page size. */
export const MAX_CLUSTER_VECTOR_TERMS = 2_000;

export function topTerms(vector: TermVector, max = MAX_CLUSTER_VECTOR_TERMS): Map<string, number> {
  if (vector.size <= max) return new Map(vector);
  return new Map([...vector].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max));
}

export function cosineSimilarity(a: TermVector, b: TermVector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of a) na += v * v;
  for (const [, v] of b) nb += v * v;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (vb !== undefined) dot += va * vb;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function similarityFromTexts(a: string, b: string): number {
  const idf = buildIdf([a, b]);
  return cosineSimilarity(tfidfVectorWithIdf(a, idf), tfidfVectorWithIdf(b, idf));
}

/** Mean pairwise cosine similarity; null when fewer than two members. */
export function averagePairwiseSimilarity(
  vectors: readonly TermVector[],
  memberIndexes: readonly number[],
): number | null {
  if (memberIndexes.length < 2) return null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < memberIndexes.length; i += 1) {
    for (let j = i + 1; j < memberIndexes.length; j += 1) {
      sum += cosineSimilarity(vectors[memberIndexes[i]!]!, vectors[memberIndexes[j]!]!);
      n += 1;
    }
  }
  return Number((sum / n).toFixed(4));
}

export interface ClusterAssignment {
  readonly id: number;
  readonly memberIndexes: readonly number[];
}

/** Farthest-first seeds; stops early when remaining docs duplicate an existing seed. */
function pickSeeds(vectors: readonly TermVector[], k: number): number[] {
  const seeds: number[] = [0];
  while (seeds.length < k) {
    let bestI = -1;
    let bestDist = DUPLICATE_EPSILON;
    for (let i = 0; i < vectors.length; i += 1) {
      if (seeds.includes(i)) continue;
      let maxSim = 0;
      for (const s of seeds) maxSim = Math.max(maxSim, cosineSimilarity(vectors[i]!, vectors[s]!));
      const dist = 1 - maxSim;
      if (dist > bestDist) {
        bestDist = dist;
        bestI = i;
      }
    }
    if (bestI < 0) break;
    seeds.push(bestI);
  }
  return seeds;
}

function nearestCentroid(v: TermVector, centroids: readonly TermVector[]): number {
  let best = 0;
  let bestSim = -1;
  for (let c = 0; c < centroids.length; c += 1) {
    const sim = cosineSimilarity(v, centroids[c]!);
    if (sim > bestSim) {
      bestSim = sim;
      best = c;
    }
  }
  return best;
}

function meanVector(group: readonly TermVector[]): Map<string, number> {
  const acc = new Map<string, number>();
  for (const vec of group) {
    for (const [term, w] of vec) acc.set(term, (acc.get(term) ?? 0) + w);
  }
  for (const [term, sum] of acc) acc.set(term, sum / group.length);
  return acc;
}

/** K-means over precomputed TF-IDF vectors. Empty clusters are dropped and ids renumbered. */
export function clusterVectors(
  fullVectors: readonly TermVector[],
  k: number,
): readonly ClusterAssignment[] {
  if (fullVectors.length === 0) return [];
  const vectors = fullVectors.map((v) => topTerms(v));
  const centroids: TermVector[] = pickSeeds(vectors, Math.min(k, vectors.length)).map(
    (i) => new Map(vectors[i]!),
  );
  let assignment: number[] = [];
  for (let iter = 0; iter < 20; iter += 1) {
    const next = vectors.map((v) => nearestCentroid(v, centroids));
    for (let c = 0; c < centroids.length; c += 1) {
      const group = vectors.filter((_, i) => next[i] === c);
      if (group.length > 0) centroids[c] = meanVector(group);
    }
    const stable = next.every((v, i) => v === assignment[i]);
    assignment = next;
    if (stable) break;
  }
  return centroids
    .map((_, c) => assignment.flatMap((a, i) => (a === c ? [i] : [])))
    .filter((members) => members.length > 0)
    .map((memberIndexes, id) => ({ id, memberIndexes }));
}

export function clusterTexts(
  texts: readonly string[],
  k: number,
  idf?: IdfMap,
): readonly ClusterAssignment[] {
  const corpusIdf = idf ?? buildIdf(texts);
  return clusterVectors(
    texts.map((t) => tfidfVectorWithIdf(t, corpusIdf)),
    k,
  );
}
