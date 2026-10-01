import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import {
  CHROMIUM_LAUNCH_OPTIONS,
  createHeadlessRenderer,
  createPinnedUpstream,
  createRequestGuard,
  fetchFollowingRedirects,
  forwardableHeaders,
  MAX_REDIRECTS,
  MAX_REQUESTS_PER_RENDER,
  NETWORK_IDLE_WAIT_MS,
  type UpstreamFetch,
} from "../../../src/infrastructure/headlessRenderer.js";
import { ErrorCodes } from "../../../src/utils/errors.js";
import type { LookupFn } from "../../../src/utils/validators.js";

interface FakeRoute {
  request: () => {
    url: () => string;
    method: () => string;
    headers: () => Record<string, string>;
    postDataBuffer: () => Buffer | null;
    resourceType: () => string;
  };
  abort: (code?: string) => Promise<void>;
  continue: () => Promise<void>;
  fulfill: (res: { status: number; headers: Record<string, string>; body: Buffer }) => Promise<void>;
}
type RouteHandler = (route: FakeRoute) => Promise<void>;

const state = vi.hoisted(() => ({
  launch: vi.fn(),
  contexts: [] as { close: ReturnType<typeof vi.fn>; options: unknown }[],
  wsClosed: 0,
  routed: {
    continued: [] as string[],
    aborted: [] as { url: string; code?: string }[],
    fulfilled: [] as { url: string; status: number; body: string }[],
  },
  finalUrl: "https://public.test/final",
  gotoError: null as Error | null,
  subresources: [] as { url: string; type: string }[],
  idleWait: vi.fn(),
  gotoDelayMs: 0,
}));

vi.mock("playwright", () => ({ chromium: { launch: state.launch } }));

function fakeRoute(url: string, type: string): FakeRoute {
  return {
    request: () => ({
      url: () => url,
      method: () => "GET",
      headers: () => ({ host: "evil", "user-agent": "ua", accept: "*/*" }),
      postDataBuffer: () => null,
      resourceType: () => type,
    }),
    abort: async (code?: string) => void state.routed.aborted.push({ url, ...(code ? { code } : {}) }),
    continue: async () => void state.routed.continued.push(url),
    fulfill: async (res) => void state.routed.fulfilled.push({ url, status: res.status, body: res.body.toString() }),
  };
}

function fakeBrowser(): { newContext: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return {
    close: vi.fn(async () => undefined),
    newContext: vi.fn(async (options: unknown) => {
      let handler: RouteHandler | undefined;
      const context = {
        options,
        close: vi.fn(async () => undefined),
        route: async (_pattern: string, h: RouteHandler) => {
          handler = h;
        },
        routeWebSocket: async (_p: RegExp, h: (ws: { close: () => Promise<void> }) => void) => {
          h({ close: async () => void (state.wsClosed += 1) });
        },
        newPage: async () => ({
          goto: async (url: string) => {
            if (state.gotoError) throw state.gotoError;
            if (state.gotoDelayMs) await new Promise((r) => setTimeout(r, state.gotoDelayMs));
            for (const r of [{ url, type: "document" }, ...state.subresources]) {
              await handler?.(fakeRoute(r.url, r.type));
            }
            return { url: () => state.finalUrl };
          },
          waitForLoadState: state.idleWait,
          content: async () => "<html><body><p>Rendered</p></body></html>",
          url: () => state.finalUrl,
        }),
      };
      state.contexts.push(context);
      return context;
    }),
  };
}

const lookup: LookupFn = async (host) => [
  { address: host.startsWith("internal") ? "10.0.0.5" : "93.184.216.34", family: 4 },
];
const config = loadConfig({ ...process.env, HEADLESS_TIMEOUT_MS: "1000" });
const upstream = vi.fn<UpstreamFetch>(async (url) => ({
  status: 200,
  headers: { "content-type": "text/plain" },
  body: Buffer.from(`body of ${url}`),
}));

beforeEach(() => {
  state.launch.mockReset();
  state.launch.mockImplementation(async () => fakeBrowser());
  state.contexts = [];
  state.wsClosed = 0;
  state.routed = { continued: [], aborted: [], fulfilled: [] };
  state.finalUrl = "https://public.test/final";
  state.gotoError = null;
  state.subresources = [];
  state.gotoDelayMs = 0;
  state.idleWait.mockReset();
  state.idleWait.mockResolvedValue(undefined);
  upstream.mockClear();
});

describe("headless renderer", () => {
  it("fetches every request through the pinned upstream and never lets Chromium hit the network", async () => {
    state.subresources = [
      { url: "https://cdn.test/app.js", type: "script" },
      { url: "http://internal.test/admin", type: "fetch" },
      { url: "https://cdn.test/hero.png", type: "image" },
      { url: "data:image/png;base64,AA", type: "image" },
    ];
    const renderer = createHeadlessRenderer(config, lookup, upstream);
    const out = await renderer.render("https://public.test/page");
    expect(out).toEqual({ html: expect.stringContaining("Rendered"), finalUrl: "https://public.test/final" });
    expect(state.launch).toHaveBeenCalledWith(CHROMIUM_LAUNCH_OPTIONS);
    expect(state.contexts[0]?.options).toMatchObject({ serviceWorkers: "block", userAgent: config.userAgent });
    expect(state.routed.fulfilled.map((f) => f.url)).toEqual(["https://public.test/page", "https://cdn.test/app.js"]);
    expect(state.routed.fulfilled[1]?.body).toBe("body of https://cdn.test/app.js");
    expect(upstream.mock.calls.map(([u]) => u)).toEqual(["https://public.test/page", "https://cdn.test/app.js"]);
    expect(upstream.mock.calls[0]?.[1].headers).toMatchObject({ "user-agent": config.userAgent });
    expect(upstream.mock.calls[1]?.[1].headers).toEqual({ "user-agent": "ua", accept: "*/*" });
    expect(state.routed.aborted.map((a) => a.url)).toEqual(["http://internal.test/admin", "https://cdn.test/hero.png"]);
    expect(state.routed.continued).toEqual(["data:image/png;base64,AA"]);
    expect(state.wsClosed).toBe(1);
    expect(state.contexts[0]?.close).toHaveBeenCalled();
  });

  it("disables Chromium's own DNS and direct connections", () => {
    expect(CHROMIUM_LAUNCH_OPTIONS.args).toContain("--host-resolver-rules=MAP * ~NOTFOUND");
    expect(CHROMIUM_LAUNCH_OPTIONS.args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  });

  it("fails the render when the document cannot be fetched and aborts failed subrequests", async () => {
    const failing = vi.fn<UpstreamFetch>(async (url) => {
      if (url.includes("cdn")) throw new Error("Host resolves to a blocked address");
      return upstream(url, { method: "GET", headers: {}, signal: AbortSignal.timeout(1000) });
    });
    state.subresources = [{ url: "https://cdn.test/app.js", type: "script" }];
    await createHeadlessRenderer(config, lookup, failing).render("https://public.test/page");
    expect(state.routed.aborted).toEqual([{ url: "https://cdn.test/app.js", code: "failed" }]);

    const down = vi.fn<UpstreamFetch>(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(createHeadlessRenderer(config, lookup, down).render("https://public.test/page")).rejects.toMatchObject({
      code: ErrorCodes.HeadlessFail,
    });
  });

  it("caps subrequests per render", async () => {
    state.subresources = Array.from({ length: MAX_REQUESTS_PER_RENDER + 5 }, (_, i) => ({
      url: `https://cdn.test/${i}.js`,
      type: "script",
    }));
    await createHeadlessRenderer(config, lookup, upstream).render("https://public.test/page");
    expect(upstream).toHaveBeenCalledTimes(MAX_REQUESTS_PER_RENDER + 1);
    expect(state.routed.aborted).toHaveLength(5);
  });

  it("follows redirects in Node, re-checking every hop", async () => {
    const hops: Record<string, { status: number; location?: string }> = {
      "https://public.test/a": { status: 301, location: "/b#frag" },
      "https://public.test/b": { status: 303, location: "https://other.test/c" },
      "https://public.test/evil": { status: 302, location: "http://internal.test/" },
      "https://public.test/ftp": { status: 302, location: "ftp://public.test/x" },
      "https://public.test/loop": { status: 302, location: "/loop" },
    };
    const seen: { url: string; method: string; body?: Buffer }[] = [];
    const redirecting = vi.fn<UpstreamFetch>(async (url, init) => {
      seen.push({ url, method: init.method, ...(init.body ? { body: init.body } : {}) });
      const hop = hops[url];
      return {
        status: hop?.status ?? 200,
        headers: hop?.location ? { location: hop.location } : {},
        body: Buffer.from("ok"),
      };
    });
    const guard = createRequestGuard(lookup);
    const init = { method: "POST", headers: {}, body: Buffer.from("x"), signal: AbortSignal.timeout(1000) };

    const done = await fetchFollowingRedirects(redirecting, guard, "https://public.test/a", init);
    expect(done.url).toBe("https://other.test/c");
    expect(seen.map((s) => [s.url, s.method, !!s.body])).toEqual([
      ["https://public.test/a", "POST", true],
      ["https://public.test/b", "GET", false],
      ["https://other.test/c", "GET", false],
    ]);

    await expect(fetchFollowingRedirects(redirecting, guard, "https://public.test/evil", init)).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
    await expect(fetchFollowingRedirects(redirecting, guard, "https://public.test/ftp", init)).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
    await expect(fetchFollowingRedirects(redirecting, guard, "https://public.test/loop", init)).rejects.toThrow(
      new RegExp(`${MAX_REDIRECTS} redirects`),
    );
  });

  it("waits for network idle within the remaining budget", async () => {
    const renderer = createHeadlessRenderer(
      loadConfig({ ...process.env, HEADLESS_TIMEOUT_MS: "10000" }),
      lookup,
      upstream,
    );
    await renderer.render("https://public.test/page");
    expect(state.idleWait).toHaveBeenCalledWith("networkidle", { timeout: NETWORK_IDLE_WAIT_MS });

    state.idleWait.mockClear();
    await createHeadlessRenderer(config, lookup, upstream).render("https://public.test/page");
    const [, options] = state.idleWait.mock.calls[0] as [string, { timeout: number }];
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(1000);
  });

  it("ignores a network-idle timeout and skips the wait when the budget is spent", async () => {
    state.idleWait.mockRejectedValue(new Error("Timeout 3000ms exceeded"));
    const renderer = createHeadlessRenderer(config, lookup, upstream);
    await expect(renderer.render("https://public.test/page")).resolves.toMatchObject({
      html: expect.stringContaining("Rendered"),
    });

    state.idleWait.mockClear();
    state.gotoDelayMs = 1100;
    await expect(renderer.render("https://public.test/page")).resolves.toBeDefined();
    expect(state.idleWait).not.toHaveBeenCalled();
  });

  it("rejects a final URL on a blocked host and still closes the context", async () => {
    state.finalUrl = "http://internal.test/after-redirect";
    const renderer = createHeadlessRenderer(config, lookup, upstream);
    await expect(renderer.render("https://public.test/")).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
    expect(state.contexts[0]?.close).toHaveBeenCalled();
  });

  it("maps navigation errors to HEADLESS_RENDER_FAIL and closes the context", async () => {
    state.gotoError = new Error("net::ERR_TIMED_OUT");
    const renderer = createHeadlessRenderer(config, lookup, upstream);
    await expect(renderer.render("https://public.test/")).rejects.toMatchObject({
      code: ErrorCodes.HeadlessFail,
      message: "net::ERR_TIMED_OUT",
    });
    expect(state.contexts[0]?.close).toHaveBeenCalled();
  });

  it("explains a missing browser and retries the launch next time", async () => {
    state.launch.mockRejectedValueOnce(new Error("Executable doesn't exist at /x"));
    const renderer = createHeadlessRenderer(config, lookup, upstream);
    await expect(renderer.render("https://public.test/")).rejects.toThrow(/npx playwright install/);
    await expect(renderer.render("https://public.test/")).resolves.toBeDefined();
    expect(state.launch).toHaveBeenCalledTimes(2);
  });

  it("default upstream refuses a page whose host rebinds to a private IP after the check", async () => {
    let calls = 0;
    const rebinding: LookupFn = async () => {
      calls += 1;
      return [{ address: calls <= 1 ? "93.184.216.34" : "10.0.0.5", family: 4 }];
    };
    const renderer = createHeadlessRenderer(config, rebinding);
    try {
      await expect(renderer.render("http://rebind.test/")).rejects.toMatchObject({ code: ErrorCodes.HeadlessFail });
      expect(calls).toBe(2);
      expect(state.routed.fulfilled).toEqual([]);
    } finally {
      await renderer.close?.();
    }
  });

  it("launches one browser for concurrent renders and closes it", async () => {
    const renderer = createHeadlessRenderer(config, lookup, upstream);
    await Promise.all([renderer.render("https://public.test/a"), renderer.render("https://public.test/b")]);
    expect(state.launch).toHaveBeenCalledTimes(1);
    const browser = (await state.launch.mock.results[0]?.value) as { close: ReturnType<typeof vi.fn> };
    await renderer.close?.();
    expect(browser.close).toHaveBeenCalled();
    await expect(renderer.close?.()).resolves.toBeUndefined();
  });

  it("validates the target before launching and requires config", async () => {
    const renderer = createHeadlessRenderer(undefined, lookup, upstream);
    await expect(renderer.render("https://public.test/")).rejects.toMatchObject({
      code: ErrorCodes.HeadlessFail,
    });
    await expect(renderer.render("http://127.0.0.1/", config)).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
    expect(state.launch).not.toHaveBeenCalled();
  });
});

describe("pinned upstream", () => {
  it("re-validates DNS at connect time, so a host that rebinds to a private IP is refused", async () => {
    let calls = 0;
    const rebinding: LookupFn = async () => {
      calls += 1;
      return [{ address: calls === 1 ? "93.184.216.34" : "10.0.0.5", family: 4 }];
    };
    const guard = createRequestGuard(rebinding);
    expect(await guard("http://rebind.test/")).toBe(true);

    const pinned = createPinnedUpstream(rebinding);
    try {
      await expect(
        pinned.fetch("http://rebind.test/", { method: "GET", headers: {}, signal: AbortSignal.timeout(2000) }),
      ).rejects.toThrow();
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      await pinned.close();
    }
  });

  it("strips hop-by-hop and pseudo headers before forwarding", () => {
    expect(
      forwardableHeaders({ Host: "x", ":authority": "x", Connection: "keep-alive", "Content-Length": "3", Accept: "a" }),
    ).toEqual({ accept: "a" });
  });
});

describe("request guard", () => {
  it("resolves each hostname once and rejects unsafe schemes and credentials", async () => {
    const spy = vi.fn(lookup);
    const guard = createRequestGuard(spy);
    expect(await guard("https://cdn.test/a.js")).toBe(true);
    expect(await guard("https://cdn.test/b.css")).toBe(true);
    expect(await guard("wss://cdn.test/socket")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await guard("blob:https://cdn.test/uuid")).toBe(true);
    expect(await guard("file:///etc/passwd")).toBe(false);
    expect(await guard("https://user:pw@cdn.test/")).toBe(false);
    expect(await guard("::not a url")).toBe(false);
    expect(await guard("http://internal.test/")).toBe(false);
  });
});
