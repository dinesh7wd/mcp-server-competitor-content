import dns from "node:dns/promises";
import net from "node:net";
import { ErrorCodes, McpError } from "./errors.js";

export type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

const IPV4_BLOCKED_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const IPV4_BLOCKLIST = new net.BlockList();
for (const [prefix, bits] of IPV4_BLOCKED_SUBNETS) IPV4_BLOCKLIST.addSubnet(prefix, bits, "ipv4");

/**
 * Reserved ranges inside global unicast 2000::/3 (everything outside 2000::/3 is blocked):
 * 2001::/23 IETF protocol assignments incl. Teredo 2001::/32, documentation 2001:db8::/32 and 3fff::/20.
 */
const IPV6_BLOCKED_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["3fff::", 20],
];

const IPV6_BLOCKLIST = new net.BlockList();
for (const [prefix, bits] of IPV6_BLOCKED_SUBNETS) IPV6_BLOCKLIST.addSubnet(prefix, bits, "ipv6");

/** Private, loopback, link-local, CGNAT, documentation, benchmark, multicast, reserved IPv4. */
export function isBlockedIpv4(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  return IPV4_BLOCKLIST.check(ip, "ipv4");
}

function stripBrackets(ip: string): string {
  return ip.replace(/^\[|\]$/g, "");
}

/** Parse any valid IPv6 text form (incl. embedded dotted IPv4) into 8 hextets. */
export function parseIpv6(ip: string): number[] | null {
  let s = stripBrackets(ip).toLowerCase().split("%")[0] ?? "";
  const dotted = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1] && dotted[2]) {
    if (!net.isIPv4(dotted[2])) return null;
    const [a, b, c, d] = dotted[2].split(".").map(Number) as [number, number, number, number];
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 2 && fill === 0)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function hextetsToIpv4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** IPv4 embedded by mapped, compatible, SIIT, NAT64 or 6to4 IPv6 addresses. */
function embeddedIpv4(h: readonly number[]): string | null {
  const zero = (from: number, to: number): boolean => h.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && h[5] === 0xffff) return hextetsToIpv4(h[6]!, h[7]!);
  if (zero(0, 4) && h[4] === 0xffff && h[5] === 0) return hextetsToIpv4(h[6]!, h[7]!);
  if (zero(0, 6)) return hextetsToIpv4(h[6]!, h[7]!);
  if (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6)) return hextetsToIpv4(h[6]!, h[7]!);
  if (h[0] === 0x2002) return hextetsToIpv4(h[1]!, h[2]!);
  return null;
}

/**
 * Allow-list: only public global unicast (2000::/3 minus reserved ranges) passes. Addresses that
 * embed an IPv4 (mapped, compatible, NAT64, 6to4) are judged by that IPv4.
 */
export function isBlockedIpv6(ip: string): boolean {
  const h = parseIpv6(ip);
  if (!h) return true;
  const v4 = embeddedIpv4(h);
  if (v4 !== null) return isBlockedIpv4(v4);
  if ((h[0]! & 0xe000) !== 0x2000) return true;
  return IPV6_BLOCKLIST.check(h.map((x) => x.toString(16)).join(":"), "ipv6");
}

export function isBlockedIp(address: string): boolean {
  const clean = stripBrackets(address);
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
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new McpError(ErrorCodes.SsrfBlocked, "Blocked hostname");
  }
  if (isBlockedIp(host)) {
    throw new McpError(ErrorCodes.SsrfBlocked, "Blocked IP address");
  }
}

/** Resolve all A/AAAA records and reject if any is private/reserved. */
export async function resolvePublicAddresses(
  hostname: string,
  lookupFn: LookupFn = dns.lookup,
): Promise<ResolvedAddress[]> {
  let records: ReadonlyArray<{ address: string; family: number }>;
  try {
    records = await lookupFn(hostname, { all: true, verbatim: true });
  } catch {
    throw new McpError(ErrorCodes.SsrfBlocked, "DNS resolution failed");
  }
  if (records.length === 0) {
    throw new McpError(ErrorCodes.SsrfBlocked, "No DNS records");
  }
  if (records.some((rec) => isBlockedIp(rec.address))) {
    throw new McpError(ErrorCodes.SsrfBlocked, "Host resolves to a blocked address");
  }
  return records.map((r) => ({ address: r.address, family: r.family }));
}

/**
 * `net.connect` lookup that only yields validated public addresses, so the socket
 * connects to exactly what was checked (no DNS-rebinding window).
 */
export function createPinnedLookup(lookupFn: LookupFn = dns.lookup): net.LookupFunction {
  return (hostname, options, callback) => {
    resolvePublicAddresses(hostname, lookupFn).then(
      (records) => {
        const family = typeof options.family === "number" ? options.family : 0;
        const usable = family === 4 || family === 6 ? records.filter((r) => r.family === family) : records;
        const first = usable[0];
        if (!first) {
          const err: NodeJS.ErrnoException = new Error(`No usable address for ${hostname}`);
          err.code = "ENOTFOUND";
          callback(err, "");
          return;
        }
        if (options.all) callback(null, usable);
        else callback(null, first.address, first.family);
      },
      (err: unknown) => callback(err as NodeJS.ErrnoException, ""),
    );
  };
}

/**
 * Parse URL, require http(s), block literal private hosts, then DNS-resolve and
 * reject if any A/AAAA record is private/reserved.
 */
export async function assertSafeHttpUrl(
  raw: string,
  lookupFn: LookupFn = dns.lookup,
): Promise<URL> {
  const url = assertPublicHttpUrl(raw);
  if (url.username || url.password) {
    throw new McpError(ErrorCodes.SsrfBlocked, "URLs with credentials are blocked");
  }
  if (!net.isIP(stripBrackets(url.hostname))) {
    await resolvePublicAddresses(url.hostname, lookupFn);
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
