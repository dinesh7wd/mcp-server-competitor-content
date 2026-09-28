import { describe, expect, it, vi } from "vitest";
import {
  createHttpClient,
  type FetchInit,
  type FetchLike,
  type FetchResponseLike,
} from "../../../src/infrastructure/httpClient.js";
import { ErrorCodes } from "../../../src/utils/errors.js";
import type { LookupFn } from "../../../src/utils/validators.js";

const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

function res(status: number, body = "", headers: Record<string, string> = {}): FetchResponseLike {
  return new Response(status === 204 ? null : body, { status, headers });
}

function client(fetchImpl: FetchLike, retries = 0, timeoutMs = 2000): ReturnType<typeof createHttpClient> {
  return createHttpClient({ fetchImpl, lookup: publicLookup, retries, timeoutMs });
}

function networkError(code: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

describe("httpClient", () => {
  it("retries a 5xx and returns the later success", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200, "ok", { "content-type": "text/html" }));
    const out = await client(fetchImpl, 1).request({ url: "https://a.example/" });
    expect(out).toMatchObject({ status: 200, body: "ok", finalUrl: "https://a.example/", redirectCount: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns the 5xx response when retries are exhausted", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockImplementation(async () => res(502, "bad"));
    const out = await client(fetchImpl, 1).request({ url: "https://a.example/" });
    expect(out.status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries network errors then fails with ScrapeFail and the cause code", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(networkError("ECONNRESET"));
    await expect(client(fetchImpl, 1).request({ url: "https://a.example/?api_key=S" })).rejects.toMatchObject({
      code: ErrorCodes.ScrapeFail,
      message: expect.stringContaining("ECONNRESET"),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the error message when a network error has no cause code", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(new Error("socket hang up"));
    await expect(client(fetchImpl).request({ url: "https://a.example/" })).rejects.toThrow(
      /socket hang up/,
    );
  });

  it("maps an aborted fetch to Timeout without retrying", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockImplementation(
      (_url: string, init: FetchInit) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await expect(client(fetchImpl, 2, 20).request({ url: "https://a.example/" })).rejects.toMatchObject({
      code: ErrorCodes.Timeout,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("applies the timeout to a hanging DNS lookup", async () => {
    const hanging: LookupFn = () => new Promise(() => undefined);
    const fetchImpl = vi.fn<FetchLike>();
    const c = createHttpClient({ fetchImpl, lookup: hanging, retries: 0, timeoutMs: 20 });
    await expect(c.request({ url: "https://slow-dns.example/" })).rejects.toMatchObject({
      code: ErrorCodes.Timeout,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies unless truncation is requested", async () => {
    const big = "x".repeat(5000);
    const fetchImpl = vi.fn<FetchLike>().mockImplementation(async () => res(200, big));
    await expect(
      client(fetchImpl).request({ url: "https://a.example/", maxBodyBytes: 1000 }),
    ).rejects.toThrow(/byte limit/);
    const cut = await client(fetchImpl).request({
      url: "https://a.example/",
      maxBodyBytes: 1000,
      truncateBody: true,
    });
    expect(cut.body).toHaveLength(1000);
  });

  it("rejects disallowed content types on success responses only", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(res(200, "%PDF", { "content-type": "application/pdf" }))
      .mockResolvedValueOnce(res(404, "nope", { "content-type": "application/json" }))
      .mockResolvedValueOnce(res(200, "<x/>", { "content-type": "application/xhtml+xml; charset=utf-8" }));
    const req = { url: "https://a.example/", allowedContentTypes: ["text/html", "application/xhtml+xml"] };
    await expect(client(fetchImpl).request(req)).rejects.toThrow(/Disallowed content-type/);
    expect((await client(fetchImpl).request(req)).status).toBe(404);
    expect((await client(fetchImpl).request(req)).status).toBe(200);
  });

  it("rejects a missing content type when types are restricted", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(res(204));
    await expect(
      client(fetchImpl).request({ url: "https://a.example/", allowedContentTypes: ["text/html"] }),
    ).rejects.toThrow(/missing/);
  });

  it("follows redirects, cancels their bodies, and reports the final URL", async () => {
    const cancel = vi.fn();
    const redirectBody = new ReadableStream<Uint8Array>({ cancel });
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response(redirectBody, { status: 301, headers: { location: "/next" } }))
      .mockResolvedValueOnce(res(200, "done"));
    const out = await client(fetchImpl).request({ url: "https://a.example/start" });
    expect(out).toMatchObject({ finalUrl: "https://a.example/next", redirectCount: 1, body: "done" });
    expect(cancel).toHaveBeenCalled();
  });

  it("stops after maxRedirects", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockImplementation(async () => res(302, "", { location: "https://a.example/loop" }));
    await expect(
      client(fetchImpl, 2).request({ url: "https://a.example/", maxRedirects: 2 }),
    ).rejects.toThrow(/Exceeded 2 redirects/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("treats missing or invalid Location as ScrapeFail without retrying", async () => {
    const missing = vi.fn<FetchLike>().mockImplementation(async () => res(302));
    await expect(client(missing, 2).request({ url: "https://a.example/" })).rejects.toMatchObject({
      code: ErrorCodes.ScrapeFail,
      message: "Redirect without Location header",
    });
    expect(missing).toHaveBeenCalledTimes(1);

    const invalid = vi.fn<FetchLike>().mockImplementation(async () => res(302, "", { location: "http://[bad" }));
    await expect(client(invalid, 2).request({ url: "https://a.example/" })).rejects.toMatchObject({
      code: ErrorCodes.ScrapeFail,
      message: "Invalid redirect Location header",
    });
    expect(invalid).toHaveBeenCalledTimes(1);
  });

  it("switches POST to GET without a body on 303 and keeps it on 307", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(res(307, "", { location: "/b" }))
      .mockResolvedValueOnce(res(303, "", { location: "/c" }))
      .mockResolvedValueOnce(res(200, "ok"));
    await client(fetchImpl).request({
      url: "https://a.example/a",
      method: "POST",
      body: "payload",
      headers: { "X-Test": "1" },
    });
    const inits = fetchImpl.mock.calls.map((c) => c[1]);
    expect(inits[1]).toMatchObject({ method: "POST", body: "payload" });
    expect(inits[2]?.method).toBe("GET");
    expect(inits[2]).not.toHaveProperty("body");
    expect(inits[2]?.headers).toEqual({ "X-Test": "1" });
  });

  it("skips SSRF validation when validateRedirects is false", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(res(200, "ok"));
    const lookup = vi.fn(publicLookup);
    const c = createHttpClient({ fetchImpl, lookup, retries: 0 });
    await c.request({ url: "https://a.example/", validateRedirects: false });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("creates and closes the default pinned agent", async () => {
    const c = createHttpClient();
    await expect(c.close?.()).resolves.toBeUndefined();
  });
});
