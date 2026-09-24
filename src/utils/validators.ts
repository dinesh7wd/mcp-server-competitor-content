import dns from "node:dns/promises";
import net from "node:net";
import { ErrorCodes, McpError } from "./errors.js";

export type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return parts;
}

/** Block private, loopback, link-local, CGNAT, multicast, reserved IPv4. */
export function isBlockedIpv4(ip: string): boolean {
  const parts = parseIpv4(ip);
  if (!parts) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 127) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a >= 224) return true;
  return false;
}

function expandIpv6(ip: string): string {
  const clean = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const halves = clean.split("::");
  let head = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  let tail = halves[1] ? halves[1].split(":").filter(Boolean) : [];
  if (halves.length === 1) {
    head = clean.split(":").filter(Boolean);
    tail = [];
  }
  const missing = 8 - head.length - tail.length;
  const full = [...head, ...Array(Math.max(0, missing)).fill("0"), ...tail];
  return full.map((h) => h.padStart(4, "0")).join(":");
}

/** Block loopback, ULA, link-local, multicast, IPv4-mapped private, AWS metadata IPv6. */
export function isBlockedIpv6(ip: string): boolean {
  const raw = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (raw === "::1" || raw === "::" || raw === "0:0:0:0:0:0:0:1") return true;

  const v4mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped?.[1]) return isBlockedIpv4(v4mapped[1]);
  const v4mappedHex = raw.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4mappedHex?.[1] && v4mappedHex[2]) {
    const hi = parseInt(v4mappedHex[1], 16);
    const lo = parseInt(v4mappedHex[2], 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >> 8) & 0xff;
    const d = lo & 0xff;
    return isBlockedIpv4(`${a}.${b}.${c}.${d}`);
  }

  let expanded: string;
  try {
    expanded = expandIpv6(raw);
  } catch {
    return true;
  }
  const first = expanded.split(":")[0] ?? "";
  const firstNum = parseInt(first, 16);
  if ((firstNum & 0xffc0) === 0xfe80) return true;
  if ((firstNum & 0xfe00) === 0xfc00) return true;
  if ((firstNum & 0xff00) === 0xff00) return true;
  if (expanded.startsWith("fd00:0ec2:")) return true;
  return false;
}

export function isBlockedIp(address: string): boolean {
  const clean = address.replace(/^\[|\]$/g, "");
  if (net.isIPv4(clean)) return isBlockedIpv4(clean);
  if (net.isIPv6(clean)) return isBlockedIpv6(clean);
  return false;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
]);

export function assertPublicHostnameLiteral(hostname: string): void {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "localhost."
  ) {
    throw new McpError(ErrorCodes.SsrfBlocked, "Blocked hostname");
  }
  if (isBlockedIp(host)) {
    throw new McpError(ErrorCodes.SsrfBlocked, "Blocked IP address");
  }
}

/**
 * Parse URL, require http(s), block literal private hosts, then DNS-resolve and
 * reject if any A/AAAA record is private/reserved.
 */
export async function assertSafeHttpUrl(
  raw: string,
  lookupFn: LookupFn = dns.lookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpError(ErrorCodes.InvalidParams, "Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpError(ErrorCodes.SsrfBlocked, "Only http(s) schemes allowed");
  }
  if (url.username || url.password) {
    throw new McpError(ErrorCodes.SsrfBlocked, "URLs with credentials are blocked");
  }

  assertPublicHostnameLiteral(url.hostname);

  if (net.isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
    return url;
  }

  let records: ReadonlyArray<{ address: string; family: number }>;
  try {
    records = await lookupFn(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new McpError(ErrorCodes.SsrfBlocked, "DNS resolution failed");
  }
  if (records.length === 0) {
    throw new McpError(ErrorCodes.SsrfBlocked, "No DNS records");
  }
  for (const rec of records) {
    if (isBlockedIp(rec.address)) {
      throw new McpError(ErrorCodes.SsrfBlocked, "Host resolves to a blocked address");
    }
  }
  return url;
}

/** Sync structural checks (no DNS) — prefer assertSafeHttpUrl for fetches. */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpError(ErrorCodes.InvalidParams, "Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpError(ErrorCodes.SsrfBlocked, "Only http(s) schemes allowed");
  }
  assertPublicHostnameLiteral(url.hostname);
  return url;
}
