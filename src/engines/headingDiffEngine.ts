export interface HeadingNode {
  readonly level: number;
  readonly text: string;
}

export interface HeadingDiff {
  readonly onlyInA: readonly string[];
  readonly onlyInB: readonly string[];
  readonly shared: readonly string[];
}

export function diffHeadings(a: readonly HeadingNode[], b: readonly HeadingNode[]): HeadingDiff {
  const setA = new Set(a.map((h) => `H${h.level}:${h.text.toLowerCase()}`));
  const setB = new Set(b.map((h) => `H${h.level}:${h.text.toLowerCase()}`));
  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const shared: string[] = [];
  for (const x of setA) {
    if (setB.has(x)) shared.push(x);
    else onlyInA.push(x);
  }
  for (const x of setB) {
    if (!setA.has(x)) onlyInB.push(x);
  }
  return { onlyInA, onlyInB, shared };
}

export function multiHeadingCompare(
  pages: readonly { url: string; headings: readonly HeadingNode[] }[],
): { url: string; headingCount: number; outline: string[] }[] {
  return pages.map((p) => ({
    url: p.url,
    headingCount: p.headings.length,
    outline: p.headings.map((h) => `H${h.level}: ${h.text}`),
  }));
}
