import { tfidfVector } from "./keywordEngine.js";

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
  return cosineSimilarity(tfidfVector(a), tfidfVector(b));
}

export interface ClusterAssignment {
  readonly id: number;
  readonly memberIndexes: readonly number[];
}

/** Simple k-means on TF-IDF bag vectors (deterministic seed via first-k init). */
export function clusterTexts(texts: readonly string[], k: number): readonly ClusterAssignment[] {
  const vectors = texts.map((t) => tfidfVector(t));
  const n = vectors.length;
  if (n === 0) return [];
  const kk = Math.min(k, n);
  const centroids = vectors.slice(0, kk).map((v) => new Map(v));
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
