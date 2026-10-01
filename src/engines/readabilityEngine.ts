import { countSyllables, sentences, words as wordTokens } from "../utils/textHelpers.js";

export interface ReadabilityResult {
  readonly fleschKincaidGrade: number;
  readonly fleschReadingEase: number;
  readonly smog: number;
  readonly colemanLiau: number;
  readonly sentenceCount: number;
  readonly wordCount: number;
  readonly avgSentenceLength: number;
}

const EMPTY_RESULT: ReadabilityResult = {
  fleschKincaidGrade: 0,
  fleschReadingEase: 0,
  smog: 0,
  colemanLiau: 0,
  sentenceCount: 0,
  wordCount: 0,
  avgSentenceLength: 0,
};

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function clamp(n: number, min: number, max = Number.POSITIVE_INFINITY): number {
  return Math.min(max, Math.max(min, n));
}

/** Formula outputs are clamped to their meaningful ranges (ease 0–100, grades ≥ 0). */
export function scoreReadability(text: string): ReadabilityResult {
  const words = wordTokens(text);
  if (words.length === 0) return EMPTY_RESULT;
  const wordCount = words.length;
  const sentenceCount = Math.max(1, sentences(text).filter((s) => wordTokens(s).length > 0).length);
  let syllables = 0;
  let letters = 0;
  let polysyllables = 0;
  for (const w of words) {
    const s = countSyllables(w);
    syllables += s;
    if (s >= 3) polysyllables += 1;
    letters += w.replace(/[^a-zA-Z]/g, "").length;
  }
  const asl = wordCount / sentenceCount;
  const asw = syllables / wordCount;
  const L = (letters / wordCount) * 100;
  const S = (sentenceCount / wordCount) * 100;
  return {
    fleschKincaidGrade: round2(clamp(0.39 * asl + 11.8 * asw - 15.59, 0)),
    fleschReadingEase: round2(clamp(206.835 - 1.015 * asl - 84.6 * asw, 0, 100)),
    smog: round2(clamp(1.043 * Math.sqrt(polysyllables * (30 / sentenceCount)) + 3.1291, 0)),
    colemanLiau: round2(clamp(0.0588 * L - 0.296 * S - 15.8, 0)),
    sentenceCount,
    wordCount,
    avgSentenceLength: round2(asl),
  };
}
