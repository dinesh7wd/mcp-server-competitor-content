import { TextDecoder } from "node:util";

const SNIFF_BYTES = 2048;
const META_CHARSET = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i;

function charsetFromContentType(contentType: string | undefined): string | undefined {
  return contentType?.match(/charset\s*=\s*["']?\s*([^"';\s]+)/i)?.[1];
}

function charsetFromBom(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return undefined;
}

function isMarkup(contentType: string | undefined): boolean {
  return !contentType || /html|xml/i.test(contentType);
}

/** `<meta charset>` or `<meta http-equiv=content-type content="...; charset=x">` in the first 2 KB. */
export function sniffMetaCharset(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, SNIFF_BYTES)).toString("latin1");
  return head.match(META_CHARSET)?.[1];
}

function decoderFor(label: string | undefined): TextDecoder | undefined {
  if (!label) return undefined;
  try {
    return new TextDecoder(label.trim().toLowerCase(), { fatal: false });
  } catch {
    return undefined;
  }
}

// WHATWG windows-1252 for 0x80–0x9F; undefined bytes keep their C1 code point.
const CP1252_C1 =
  "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f" +
  "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";

// Some Node releases decode windows-1252 (and its latin1/ascii aliases) as ISO-8859-1.
function fixCp1252(text: string): string {
  return text.replace(/[\u0080-\u009f]/g, (c) => CP1252_C1[c.charCodeAt(0) - 0x80] ?? c);
}

/** Decode with BOM, then Content-Type charset, then meta sniff (markup only), then UTF-8. */
export function decodeBody(bytes: Uint8Array, contentType?: string): string {
  const decoder =
    decoderFor(charsetFromBom(bytes)) ??
    decoderFor(charsetFromContentType(contentType)) ??
    (isMarkup(contentType) ? decoderFor(sniffMetaCharset(bytes)) : undefined) ??
    new TextDecoder("utf-8", { fatal: false });
  const text = decoder.decode(bytes);
  return decoder.encoding === "windows-1252" ? fixCp1252(text) : text;
}
