import dns from "node:dns/promises";
import type { Browser, BrowserContext, Route } from "playwright";
import { Agent, fetch as undiciFetch } from "undici";
import type { AppConfig } from "../config.js";
import { ErrorCodes, McpError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { safeUrlForLog } from "../utils/redact.js";
import { assertSafeHttpUrl, createPinnedLookup, type LookupFn } from "../utils/validators.js";
import { readLimitedBody } from "./httpClient.js";

export interface RenderResult {
  readonly html: string;
  readonly finalUrl: string;
}

export interface HeadlessRenderer {
  render(url: string, config?: AppConfig): Promise<string | RenderResult>;
  close?(): Promise<void>;
}

export interface UpstreamRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Buffer;
  readonly signal: AbortSignal;
}

export interface UpstreamResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

/** Performs one HTTP hop (no redirect following) on behalf of the browser. */
export type UpstreamFetch = (url: string, init: UpstreamRequest) => Promise<UpstreamResponse>;

const LOCAL_SCHEMES = new Set(["data:", "blob:"]);
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
/** Not needed to extract text; skipping them saves bandwidth and upstream requests. */
const SKIPPED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
/** Best-effort wait for SPA data fetches after DOMContentLoaded; timeouts are ignored. */
export const NETWORK_IDLE_WAIT_MS = 3000;
export const MAX_REQUESTS_PER_RENDER = 150;
export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTTP_SCHEMES = new Set(["http:", "https:"]);
export const MAX_SUBRESOURCE_BYTES = 5 * 1024 * 1024;

/**
 * Chromium never touches the network itself: every request is intercepted and fetched by the
 * pinned Node client. These flags make anything that slips past interception (preconnect,
 * WebRTC, a missed request) fail to resolve instead of reaching a host on its own.
 */
export const CHROMIUM_LAUNCH_OPTIONS = {
  headless: true,
  args: ["--host-resolver-rules=MAP * ~NOTFOUND", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
} as const;

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "expect",
]);
/** undici already decoded the body, so length/encoding headers would no longer be true. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
]);

export function forwardableHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key.startsWith(":") || HOP_BY_HOP_REQUEST_HEADERS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Default upstream: undici through an Agent whose socket lookup re-resolves and validates every
 * address at connect time, so a hostname cannot rebind to a private IP between check and use.
 */
export function createPinnedUpstream(lookup?: LookupFn): { fetch: UpstreamFetch; close(): Promise<void> } {
  const agent = new Agent({ connect: { lookup: createPinnedLookup(lookup ?? dns.lookup) } });
  return {
    async fetch(url, init) {
      const res = await undiciFetch(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body && init.body.length > 0 ? { body: init.body } : {}),
        redirect: "manual",
        signal: init.signal,
        dispatcher: agent,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        if (!STRIPPED_RESPONSE_HEADERS.has(key)) headers[key] = value;
      });
      const cookies = res.headers.getSetCookie();
      if (cookies.length > 0) headers["set-cookie"] = cookies.join("\n");
      const body = await readLimitedBody(res.body, MAX_SUBRESOURCE_BYTES, false);
      return { status: res.status, headers, body: Buffer.from(body.buffer, body.byteOffset, body.byteLength) };
    },
    close: () => agent.close(),
  };
}

/** Per-render verdict cache so each hostname is resolved once, not once per subresource. */
export function createRequestGuard(lookup?: LookupFn): (rawUrl: string) => Promise<boolean> {
  const verdicts = new Map<string, Promise<boolean>>();
  return async (rawUrl: string): Promise<boolean> => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (LOCAL_SCHEMES.has(url.protocol)) return true;
    if (!NETWORK_SCHEMES.has(url.protocol) || url.username || url.password) return false;
    let verdict = verdicts.get(url.hostname);
    if (!verdict) {
      verdict = assertSafeHttpUrl(`http://${url.host}/`, lookup).then(
        () => true,
        () => false,
      );
      verdicts.set(url.hostname, verdict);
    }
    return verdict;
  };
}

/**
 * Chromium does not route the follow-up request of a fulfilled 3xx (it would resolve the target
 * itself), so redirects are followed here and every hop is re-checked before it is fetched.
 */
export async function fetchFollowingRedirects(
  upstream: UpstreamFetch,
  isAllowed: (url: string) => Promise<boolean>,
  url: string,
  init: UpstreamRequest,
): Promise<{ url: string; res: UpstreamResponse }> {
  let current = url;
  let req = init;
  for (let hop = 0; ; hop += 1) {
    const res = await upstream(current, req);
    const location = res.headers.location;
    if (!REDIRECT_STATUSES.has(res.status) || !location) return { url: current, res };
    if (hop >= MAX_REDIRECTS) throw new McpError(ErrorCodes.ScrapeFail, `Exceeded ${MAX_REDIRECTS} redirects`);
    const next = new URL(location, current);
    next.hash = "";
    if (!HTTP_SCHEMES.has(next.protocol) || !(await isAllowed(next.href))) {
      throw new McpError(ErrorCodes.SsrfBlocked, "Redirect to a blocked address");
    }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && req.method === "POST")) {
      const { body: _dropped, ...rest } = req;
      req = { ...rest, method: "GET" };
    }
    current = next.href;
  }
}

async function installGuards(
  context: BrowserContext,
  cfg: AppConfig,
  upstream: UpstreamFetch,
  isAllowed: (url: string) => Promise<boolean>,
  prefetched: Map<string, UpstreamResponse>,
): Promise<void> {
  let remaining = MAX_REQUESTS_PER_RENDER;
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = request.url();
    if (!(await isAllowed(url))) return route.abort("blockedbyclient");
    if (LOCAL_SCHEMES.has(new URL(url).protocol)) return route.continue();
    const ready = request.method() === "GET" ? prefetched.get(url) : undefined;
    if (ready) {
      prefetched.delete(url);
      return route.fulfill({ status: ready.status, headers: ready.headers, body: ready.body });
    }
    if (SKIPPED_RESOURCE_TYPES.has(request.resourceType()) || remaining <= 0) {
      return route.abort("blockedbyclient");
    }
    remaining -= 1;
    try {
      const body = request.postDataBuffer();
      const { res } = await fetchFollowingRedirects(upstream, isAllowed, url, {
        method: request.method(),
        headers: forwardableHeaders(request.headers()),
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(cfg.headlessTimeoutMs),
      });
      await route.fulfill({ status: res.status, headers: res.headers, body: res.body });
    } catch (err) {
      logger.warn("headless_subrequest_fail", {
        url: safeUrlForLog(url),
        error: err instanceof Error ? err.message : "fail",
      });
      await route.abort("failed").catch(() => undefined);
    }
  });
  if (typeof context.routeWebSocket === "function") {
    await context.routeWebSocket(/.*/, (ws) => ws.close({ code: 1008, reason: "blocked" }));
  }
}

function toRenderError(err: unknown, url: string): McpError {
  const msg = err instanceof Error ? err.message : "headless render failed";
  logger.error("headless_fail", { url: safeUrlForLog(url), error: msg });
  if (msg.includes("Executable doesn't exist") || msg.includes("browserType.launch")) {
    return new McpError(
      ErrorCodes.HeadlessFail,
      "Playwright browser missing. Run: npx playwright install chromium",
    );
  }
  if (err instanceof McpError) return err;
  return new McpError(ErrorCodes.HeadlessFail, msg);
}

export function createHeadlessRenderer(
  defaultConfig?: AppConfig,
  lookup?: LookupFn,
  upstreamOverride?: UpstreamFetch,
): HeadlessRenderer {
  let browserPromise: Promise<Browser> | null = null;
  let pinned: ReturnType<typeof createPinnedUpstream> | null = null;
  const upstream: UpstreamFetch =
    upstreamOverride ??
    ((url, init) => {
      pinned ??= createPinnedUpstream(lookup);
      return pinned.fetch(url, init);
    });

  const getBrowser = (): Promise<Browser> => {
    if (!browserPromise) {
      const launching = import("playwright").then((pw) => pw.chromium.launch(CHROMIUM_LAUNCH_OPTIONS));
      browserPromise = launching;
      launching.catch(() => {
        if (browserPromise === launching) browserPromise = null;
      });
    }
    return browserPromise;
  };

  async function renderInContext(context: BrowserContext, url: string, cfg: AppConfig): Promise<RenderResult> {
    const started = Date.now();
    const isAllowed = createRequestGuard(lookup);
    const target = new URL(url);
    target.hash = "";
    const document = await fetchFollowingRedirects(upstream, isAllowed, target.href, {
      method: "GET",
      headers: { "user-agent": cfg.userAgent, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      signal: AbortSignal.timeout(cfg.headlessTimeoutMs),
    });
    const prefetched = new Map([[document.url, document.res]]);
    await installGuards(context, cfg, upstream, isAllowed, prefetched);
    const page = await context.newPage();
    const remaining = cfg.headlessTimeoutMs - (Date.now() - started);
    await page.goto(document.url, { waitUntil: "domcontentloaded", timeout: Math.max(remaining, 1) });
    const idleBudget = Math.min(NETWORK_IDLE_WAIT_MS, cfg.headlessTimeoutMs - (Date.now() - started));
    if (idleBudget > 0) {
      await page.waitForLoadState("networkidle", { timeout: idleBudget }).catch(() => undefined);
    }
    const html = await page.content();
    const finalUrl = page.url();
    if (!(await isAllowed(finalUrl))) {
      throw new McpError(ErrorCodes.SsrfBlocked, "Headless navigation ended on a blocked address");
    }
    return { html, finalUrl };
  }

  return {
    async render(url: string, config?: AppConfig): Promise<RenderResult> {
      const cfg = config ?? defaultConfig;
      if (!cfg) throw new McpError(ErrorCodes.HeadlessFail, "Headless config missing");
      await assertSafeHttpUrl(url, lookup);
      let context: BrowserContext | undefined;
      try {
        const browser = await getBrowser();
        context = await browser.newContext({
          userAgent: cfg.userAgent,
          javaScriptEnabled: true,
          serviceWorkers: "block",
        });
        return await renderInContext(context, url, cfg);
      } catch (err) {
        throw toRenderError(err, url);
      } finally {
        await context?.close().catch(() => undefined);
      }
    },
    async close(): Promise<void> {
      const pending = browserPromise;
      browserPromise = null;
      const browser = await pending?.catch(() => null);
      await browser?.close();
      const agent = pinned;
      pinned = null;
      await agent?.close();
    },
  };
}
