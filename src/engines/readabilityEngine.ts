import { countSyllables, sentences } from "../utils/textHelpers.js";

export interface ReadabilityResult {
  readonly fleschKincaidGrade: number;
  readonly fleschReadingEase: number;
  readonly smog: number;
  readonly colemanLiau: number;
  readonly sentenceCount: number;
  readonly wordCount: number;
  readonly avgSentenceLength: number;
}

export function scoreReadability(text: string): ReadabilityResult {
  const sents = sentences(text);
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length || 1;
  const sentenceCount = sents.length || 1;
  let syllables = 0;
  let letters = 0;
  for (const w of words) {
    syllables += countSyllables(w);
    letters += w.replace(/[^a-zA-Z]/g, "").length;
  }
  const asl = wordCount / sentenceCount;
  const asw = syllables / wordCount;
  const fleschReadingEase = Number((206.835 - 1.015 * asl - 84.6 * asw).toFixed(2));
  const fleschKincaidGrade = Number((0.39 * asl + 11.8 * asw - 15.59).toFixed(2));
  const polysyllables = words.filter((w) => countSyllables(w) >= 3).length;
  const smog = Number((1.043 * Math.sqrt(polysyllables * (30 / sentenceCount)) + 3.1291).toFixed(2));
  const L = (letters / wordCount) * 100;
  const S = (sentenceCount / wordCount) * 100;
  const colemanLiau = Number((0.0588 * L - 0.296 * S - 15.8).toFixed(2));
  return {
    fleschKincaidGrade,
    fleschReadingEase,
    smog,
    colemanLiau,
    sentenceCount,
    wordCount,
    avgSentenceLength: Number(asl.toFixed(2)),
  };
}
