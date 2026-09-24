import { buildIdf, tfidfVector, tfidfVectorWithIdf } from "./keywordEngine.js";

export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
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

export interface ClusterAssignment {
  readonly id: number;
  readonly memberIndexes: readonly number[];
}

/**
 * K-means on TF-IDF bag vectors.
 * Centroids seeded by farthest-first (not first-k) for order-independence of init quality.
 */
export function clusterTexts(
  texts: readonly string[],
  k: number,
  idf?: Map<string, number>,
): readonly ClusterAssignment[] {
  const corpusIdf = idf ?? buildIdf(texts);
  const vectors = texts.map((t) => tfidfVectorWithIdf(t, corpusIdf));
  const n = vectors.length;
  if (n === 0) return [];
  const kk = Math.min(k, n);

  // Farthest-first traversal for deterministic, order-robust seeds
  const seedIdx: number[] = [0];
  while (seedIdx.length < kk) {
    let bestI = 0;
    let bestDist = -1;
    for (let i = 0; i < n; i += 1) {
      if (seedIdx.includes(i)) continue;
      let minSim = Infinity;
      for (const s of seedIdx) {
        minSim = Math.min(minSim, cosineSimilarity(vectors[i]!, vectors[s]!));
      }
      const dist = 1 - (minSim === Infinity ? 0 : minSim);
      if (dist > bestDist) {
        bestDist = dist;
        bestI = i;
      }
    }
    seedIdx.push(bestI);
  }

  const centroids = seedIdx.map((i) => new Map(vectors[i]!));
  let assignment = new Array<number>(n).fill(0);

  for (let iter = 0; iter < 20; iter += 1) {
    const next = vectors.map((v) => {
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
    });
    const groups: Map<string, number>[][] = Array.from({ length: kk }, () => []);
    next.forEach((c, i) => groups[c]!.push(vectors[i]!));
    for (let c = 0; c < kk; c += 1) {
      const group = groups[c]!;
      if (group.length === 0) continue;
      const acc = new Map<string, number>();
      for (const vec of group) {
        for (const [term, w] of vec) acc.set(term, (acc.get(term) ?? 0) + w);
      }
      for (const [term, sum] of acc) acc.set(term, sum / group.length);
      centroids[c] = acc;
    }
    if (next.every((v, i) => v === assignment[i])) break;
    assignment = next;
  }

  const clusters: ClusterAssignment[] = [];
  for (let c = 0; c < kk; c += 1) {
    const memberIndexes = assignment
      .map((a, i) => (a === c ? i : -1))
      .filter((i) => i >= 0);
    clusters.push({ id: c, memberIndexes });
  }
  return clusters;
}

// Keep tfidfVector export path for engines that still import via similarity
export { tfidfVector };
