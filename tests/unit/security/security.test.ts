import type { LookupAddress } from "node:dns";
import { describe, expect, it, vi } from "vitest";
import {
  assertPublicHttpUrl,
  assertSafeHttpUrl,
  createPinnedLookup,
  isBlockedIp,
  isBlockedIpv4,
  isBlockedIpv6,
  parseIpv6,
  type LookupFn,
} from "../../../src/utils/validators.js";
import { redactSecrets, safeUrlForLog } from "../../../src/utils/redact.js";
import { ErrorCodes } from "../../../src/utils/errors.js";
import {
  createHttpClient,
  type FetchLike,
  type FetchResponseLike,
} from "../../../src/infrastructure/httpClient.js";

function lookupMap(map: Record<string, string>): LookupFn {
  return vi.fn(async (hostname: string) => {
    const address = map[hostname];
    if (!address) throw new Error(`ENOTFOUND ${hostname}`);
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  });
}

function redirectTo(location: string): FetchResponseLike {
  return new Response(null, { status: 302, headers: { Location: location } });
}

describe("SSRF validators", () => {
  it("blocks loopback, CGNAT, link-local, metadata IPv4", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "100.64.1.1", "169.254.169.254", "192.168.1.1"]) {
      expect(isBlockedIpv4(ip)).toBe(true);
    }
    expect(isBlockedIpv4("8.8.8.8")).toBe(false);
    expect(isBlockedIpv4("not-an-ip")).toBe(false);
  });

  it("blocks reserved, documentation and benchmark IPv4 ranges", () => {
    for (const ip of [
      "0.1.2.3",
      "192.0.0.8",
      "192.0.2.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedIpv4(ip), ip).toBe(true);
    }
  });

  it("allows public addresses inside 192.0.0.0/16 outside the reserved /24s", () => {
    expect(isBlockedIpv4("192.0.43.10")).toBe(false);
    expect(isBlockedIpv4("192.0.1.1")).toBe(false);
    expect(isBlockedIpv4("198.20.0.1")).toBe(false);
  });

  it("blocks IPv6 loopback, ULA, link-local, mapped, AWS IMDS", () => {
    expect(isBlockedIpv6("::1")).toBe(true);
    expect(isBlockedIpv6("::")).toBe(true);
    expect(isBlockedIpv6("fe80::1")).toBe(true);
    expect(isBlockedIpv6("fd00:ec2::254")).toBe(true);
    expect(isBlockedIpv6("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIpv6("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIp("[::1]")).toBe(true);
  });

  it("decodes IPv4 embedded in mapped, compatible, NAT64 and 6to4 IPv6", () => {
    for (const ip of [
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "::ffff:0:7f00:1",
      "::7f00:1",
      "::127.0.0.1",
      "64:ff9b::7f00:1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b:1::a00:1",
      "2002:7f00:1::",
      "2002:a9fe:a9fe::1",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    expect(isBlockedIp("64:ff9b::808:808")).toBe(false);
    expect(isBlockedIp("2002:808:808::1")).toBe(false);
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("blocks site-local, documentation, discard and multicast IPv6", () => {
    for (const ip of ["fec0::1", "2001:db8::1", "100::1", "ff02::1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });

  it("parses IPv6 text forms strictly", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("[fe80::1%eth0]")?.[0]).toBe(0xfe80);
    expect(parseIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIpv6("1::2::3")).toBeNull();
    expect(parseIpv6("1:2:3:4:5:6:7:8::")).toBeNull();
    expect(parseIpv6("1:2:3")).toBeNull();
    expect(parseIpv6("::ffff:999.1.1.1")).toBeNull();
    expect(parseIpv6("gggg::1")).toBeNull();
    expect(isBlockedIpv6("not-ipv6")).toBe(true);
  });

  it("blocks localhost variants and metadata hostnames without DNS", async () => {
    const lookup = vi.fn();
    for (const url of [
      "http://localhost/admin",
      "http://localhost./",
      "http://app.localhost/",
      "http://printer.local/",
      "http://metadata.goog/",
      "http://127.0.0.1/",
      "http://[::ffff:127.0.0.1]/",
      "http://2130706433/",
    ]) {
      await expect(assertSafeHttpUrl(url, lookup), url).rejects.toMatchObject({
        code: ErrorCodes.SsrfBlocked,
      });
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects bad URLs, schemes and credentials", async () => {
    await expect(assertSafeHttpUrl("not a url")).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
    await expect(assertSafeHttpUrl("ftp://example.com/")).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
    await expect(assertSafeHttpUrl("http://u:p@example.com/")).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
    expect(() => assertPublicHttpUrl("file:///etc/passwd")).toThrow();
  });

  it("blocks DNS that resolves to any private IP, fails, or is empty", async () => {
    const mixed = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(assertSafeHttpUrl("https://evil.example/x", mixed)).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
    const failing = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertSafeHttpUrl("https://nx.example/", failing)).rejects.toThrow(
      "DNS resolution failed",
    );
    const empty = vi.fn().mockResolvedValue([]);
    await expect(assertSafeHttpUrl("https://empty.example/", empty)).rejects.toThrow("No DNS records");
  });

  it("allows public DNS", async () => {
    const url = await assertSafeHttpUrl("https://example.com/path", lookupMap({ "example.com": "93.184.216.34" }));
    expect(url.hostname).toBe("example.com");
  });
});

describe("pinned lookup", () => {
  const pinnedResult = (
    lookup: LookupFn,
    options: { all?: boolean; family?: number },
  ): Promise<{ err: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }> =>
    new Promise((resolve) => {
      createPinnedLookup(lookup)("host.test", options, (err, address, family) =>
        resolve({ err, address, ...(family !== undefined ? { family } : {}) }),
      );
    });

  const dual: LookupFn = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1::1", family: 6 },
  ];

  it("returns only validated addresses in single and all modes", async () => {
    expect(await pinnedResult(dual, {})).toMatchObject({ err: null, address: "93.184.216.34", family: 4 });
    expect(await pinnedResult(dual, { family: 6 })).toMatchObject({ address: "2606:2800:220:1::1" });
    const all = await pinnedResult(dual, { all: true });
    expect(all.address).toHaveLength(2);
  });

  it("errors when no address matches the requested family", async () => {
    const v4only: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
    const res = await pinnedResult(v4only, { family: 6 });
    expect(res.err?.code).toBe("ENOTFOUND");
  });

  it("rejects a hostname that resolves to loopback", async () => {
    const res = await pinnedResult(async () => [{ address: "127.0.0.1", family: 4 }], {});
    expect(res.err).toMatchObject({ code: ErrorCodes.SsrfBlocked });
  });

  it("blocks DNS rebinding between validation and connect (real undici)", async () => {
    let calls = 0;
    const rebinding: LookupFn = async () => {
      calls += 1;
      return [{ address: calls === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
    };
    const client = createHttpClient({ lookup: rebinding, retries: 0, timeoutMs: 5000 });
    try {
      await expect(client.request({ url: "http://rebind.test/" })).rejects.toMatchObject({
        code: ErrorCodes.SsrfBlocked,
      });
      expect(calls).toBe(2);
    } finally {
      await client.close?.();
    }
  });
});

describe("redact secrets", () => {
  it("strips api_key from URLs and messages", () => {
    const u = "https://serpapi.com/search.json?q=shoes&api_key=SECRET123&gl=us";
    expect(safeUrlForLog(u)).not.toContain("SECRET");
    expect(safeUrlForLog(u)).not.toContain("api_key=");
    expect(redactSecrets(`Timeout ${u}`)).toContain("REDACTED");
    expect(redactSecrets(`Timeout ${u}`)).not.toContain("SECRET123");
    expect(safeUrlForLog("not a url ?token=abc")).not.toContain("abc");
  });
});

describe("http redirect re-validation", () => {
  it("rejects a redirect to a loopback literal without fetching it", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(redirectTo("http://127.0.0.1:9/admin"));
    const client = createHttpClient({ fetchImpl, retries: 0, timeoutMs: 2000 });
    await expect(client.request({ url: "http://8.8.8.8/" })).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect hop whose hostname resolves to 127.0.0.1", async () => {
    const lookup = lookupMap({ "good.example": "93.184.216.34", "evil.example": "127.0.0.1" });
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(redirectTo("http://evil.example/steal"));
    const client = createHttpClient({ fetchImpl, lookup, retries: 2, timeoutMs: 2000 });
    await expect(client.request({ url: "http://good.example/" })).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://good.example/");
    expect(lookup).toHaveBeenCalledWith("evil.example", expect.anything());
  });
});
