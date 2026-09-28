import { describe, expect, it } from "vitest";
import { decodeBody, sniffMetaCharset } from "../../../src/utils/charset.js";

const cafe1252 = Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94]);

function html(head: string, bodyBytes: number[]): Uint8Array {
  return Uint8Array.from([...Buffer.from(`<html><head>${head}</head><body>`, "latin1"), ...bodyBytes]);
}

describe("decodeBody", () => {
  it("uses the Content-Type charset (windows-1252)", () => {
    expect(decodeBody(cafe1252, "text/html; charset=windows-1252")).toBe("Café \u201cq\u201d");
    expect(decodeBody(cafe1252, 'text/html; charset="Windows-1252"')).toBe("Café \u201cq\u201d");
    expect(decodeBody(Uint8Array.from([0x80, 0x81, 0x96, 0x9f]), "text/html; charset=iso-8859-1")).toBe(
      "\u20ac\u0081\u2013\u0178",
    );
  });

  it("sniffs <meta charset> when the header has none", () => {
    const bytes = html('<meta charset="iso-8859-1">', [0x63, 0x61, 0x66, 0xe9]);
    expect(sniffMetaCharset(bytes)).toBe("iso-8859-1");
    expect(decodeBody(bytes, "text/html")).toContain("café");
  });

  it("sniffs <meta http-equiv=content-type>", () => {
    const bytes = html(
      '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">',
      [0x93, 0x68, 0x69, 0x94],
    );
    expect(decodeBody(bytes)).toContain("\u201chi\u201d");
  });

  it("prefers the header over the meta tag and ignores meta beyond 2 KB", () => {
    const bytes = html('<meta charset="windows-1252">', [0xc3, 0xa9]);
    expect(decodeBody(bytes, "text/html; charset=utf-8")).toContain("é");
    const late = Uint8Array.from(
      Buffer.from(`${" ".repeat(2100)}<meta charset="windows-1252"><p>\u00e9</p>`, "utf8"),
    );
    expect(sniffMetaCharset(late)).toBeUndefined();
    expect(decodeBody(late, "text/html")).toContain("é");
  });

  it("falls back to UTF-8 for unknown labels", () => {
    const utf8 = Uint8Array.from(Buffer.from("naïve", "utf8"));
    expect(decodeBody(utf8, "text/html; charset=x-bogus-charset")).toBe("naïve");
    expect(decodeBody(html('<meta charset="nope-42">', [...Buffer.from("ü", "utf8")]))).toContain("ü");
  });

  it("honours a BOM and skips meta sniffing for non-markup types", () => {
    expect(decodeBody(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]), "text/html; charset=windows-1252")).toBe("hi");
    expect(decodeBody(Uint8Array.from([0xff, 0xfe, 0x68, 0x00]))).toBe("h");
    expect(decodeBody(Uint8Array.from([0xfe, 0xff, 0x00, 0x68]))).toBe("h");
    const text = Uint8Array.from(Buffer.from('<meta charset="windows-1252"> ü', "utf8"));
    expect(decodeBody(text, "text/plain")).toContain("ü");
  });
});
