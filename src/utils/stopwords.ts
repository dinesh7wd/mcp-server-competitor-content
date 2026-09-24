/** Minimal English stopword set for TF-IDF. */
export const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set([
  "a","about","above","after","again","against","all","am","an","and","any","are","as","at",
  "be","because","been","before","being","below","between","both","but","by","can","did","do",
  "does","doing","down","during","each","few","for","from","further","had","has","have","having",
  "he","her","here","hers","herself","him","himself","his","how","i","if","in","into","is","it",
  "its","itself","just","me","more","most","my","myself","no","nor","not","now","of","off","on",
  "once","only","or","other","our","ours","ourselves","out","over","own","same","she","should",
  "so","some","such","than","that","the","their","theirs","them","themselves","then","there",
  "these","they","this","those","through","to","too","under","until","up","very","was","we",
  "were","what","when","where","which","while","who","whom","why","will","with","you","your",
  "yours","yourself","yourselves","also","may","might","shall","would","could","like","get",
  "got","one","two","three","new","used","using","use","via","per","etc",
]);

export function isStopword(token: string): boolean {
  return ENGLISH_STOPWORDS.has(token.toLowerCase());
}
