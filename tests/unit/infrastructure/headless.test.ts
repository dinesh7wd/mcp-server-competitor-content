import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import {
  createHeadlessRenderer,
  createRequestGuard,
  NETWORK_IDLE_WAIT_MS,
} from "../../../src/infrastructure/headlessRenderer.js";
import { ErrorCodes } from "../../../src/utils/errors.js";
import type { LookupFn } from "../../../src/utils/validators.js";

type RouteHandler = (route: {
  request: () => { url: () => string };
  abort: () => Promise<void>;
  continue: () => Promise<void>;
}) => Promise<void>;

const state = vi.hoisted(() => ({
  launch: vi.fn(),
  contexts: [] as { close: ReturnType<typeof vi.fn>; options: unknown }[],
  wsClosed: 0,
  routed: { continued: [] as string[], aborted: [] as string[] },
  finalUrl: "https://public.test/final",
  gotoError: null as Error | null,
  subresources: [] as string[],
  idleWait: vi.fn(),
  gotoDelayMs: 0,
}));

vi.mock("playwright", () => ({ chromium: { launch: state.launch } }));

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
            for (const u of [url, ...state.subresources]) {
              await handler?.({
                request: () => ({ url: () => u }),
                abort: async () => void state.routed.aborted.push(u),
                continue: async () => void state.routed.continued.push(u),
              });
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

beforeEach(() => {
  state.launch.mockReset();
  state.launch.mockImplementation(async () => fakeBrowser());
  state.contexts = [];
  state.wsClosed = 0;
  state.routed = { continued: [], aborted: [] };
  state.finalUrl = "https://public.test/final";
  state.gotoError = null;
  state.subresources = [];
  state.gotoDelayMs = 0;
  state.idleWait.mockReset();
  state.idleWait.mockResolvedValue(undefined);
});

describe("headless renderer", () => {
  it("renders with service workers blocked, WebSockets closed, and the context closed", async () => {
    state.subresources = ["https://cdn.test/app.js", "http://internal.test/admin", "data:image/png;base64,AA"];
    const renderer = createHeadlessRenderer(config, lookup);
    const out = await renderer.render("https://public.test/page");
    expect(out).toEqual({ html: expect.stringContaining("Rendered"), finalUrl: "https://public.test/final" });
    expect(state.contexts[0]?.options).toMatchObject({ serviceWorkers: "block", userAgent: config.userAgent });
    expect(state.routed.aborted).toEqual(["http://internal.test/admin"]);
    expect(state.routed.continued).toContain("data:image/png;base64,AA");
    expect(state.wsClosed).toBe(1);
    expect(state.contexts[0]?.close).toHaveBeenCalled();
  });

  it("waits for network idle within the remaining budget", async () => {
    const renderer = createHeadlessRenderer(
      loadConfig({ ...process.env, HEADLESS_TIMEOUT_MS: "10000" }),
      lookup,
    );
    await renderer.render("https://public.test/page");
    expect(state.idleWait).toHaveBeenCalledWith("networkidle", { timeout: NETWORK_IDLE_WAIT_MS });

    state.idleWait.mockClear();
    await createHeadlessRenderer(config, lookup).render("https://public.test/page");
    const [, options] = state.idleWait.mock.calls[0] as [string, { timeout: number }];
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(1000);
  });

  it("ignores a network-idle timeout and skips the wait when the budget is spent", async () => {
    state.idleWait.mockRejectedValue(new Error("Timeout 3000ms exceeded"));
    const renderer = createHeadlessRenderer(config, lookup);
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
    const renderer = createHeadlessRenderer(config, lookup);
    await expect(renderer.render("https://public.test/")).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
    expect(state.contexts[0]?.close).toHaveBeenCalled();
  });

  it("maps navigation errors to HEADLESS_RENDER_FAIL and closes the context", async () => {
    state.gotoError = new Error("net::ERR_TIMED_OUT");
    const renderer = createHeadlessRenderer(config, lookup);
    await expect(renderer.render("https://public.test/")).rejects.toMatchObject({
      code: ErrorCodes.HeadlessFail,
      message: "net::ERR_TIMED_OUT",
    });
    expect(state.contexts[0]?.close).toHaveBeenCalled();
  });

  it("explains a missing browser and retries the launch next time", async () => {
    state.launch.mockRejectedValueOnce(new Error("Executable doesn't exist at /x"));
    const renderer = createHeadlessRenderer(config, lookup);
    await expect(renderer.render("https://public.test/")).rejects.toThrow(/npx playwright install/);
    await expect(renderer.render("https://public.test/")).resolves.toBeDefined();
    expect(state.launch).toHaveBeenCalledTimes(2);
  });

  it("launches one browser for concurrent renders and closes it", async () => {
    const renderer = createHeadlessRenderer(config, lookup);
    await Promise.all([renderer.render("https://public.test/a"), renderer.render("https://public.test/b")]);
    expect(state.launch).toHaveBeenCalledTimes(1);
    const browser = (await state.launch.mock.results[0]?.value) as { close: ReturnType<typeof vi.fn> };
    await renderer.close?.();
    expect(browser.close).toHaveBeenCalled();
    await expect(renderer.close?.()).resolves.toBeUndefined();
  });

  it("validates the target before launching and requires config", async () => {
    const renderer = createHeadlessRenderer(undefined, lookup);
    await expect(renderer.render("https://public.test/")).rejects.toMatchObject({
      code: ErrorCodes.HeadlessFail,
    });
    await expect(renderer.render("http://127.0.0.1/", config)).rejects.toMatchObject({
      code: ErrorCodes.SsrfBlocked,
    });
    expect(state.launch).not.toHaveBeenCalled();
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
