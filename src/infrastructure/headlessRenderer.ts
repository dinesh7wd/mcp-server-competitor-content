import type { Browser, BrowserContext, Route } from "playwright";
import type { AppConfig } from "../config.js";
import { ErrorCodes, McpError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { safeUrlForLog } from "../utils/redact.js";
import { assertSafeHttpUrl, type LookupFn } from "../utils/validators.js";

export interface RenderResult {
  readonly html: string;
  readonly finalUrl: string;
}

export interface HeadlessRenderer {
  render(url: string, config?: AppConfig): Promise<string | RenderResult>;
  close?(): Promise<void>;
}

const LOCAL_SCHEMES = new Set(["data:", "blob:"]);
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
/** Best-effort wait for SPA data fetches after DOMContentLoaded; timeouts are ignored. */
export const NETWORK_IDLE_WAIT_MS = 3000;

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

async function installGuards(context: BrowserContext, lookup?: LookupFn): Promise<(u: string) => Promise<boolean>> {
  const isAllowed = createRequestGuard(lookup);
  await context.route("**/*", async (route: Route) => {
    if (await isAllowed(route.request().url())) await route.continue();
    else await route.abort();
  });
  if (typeof context.routeWebSocket === "function") {
    await context.routeWebSocket(/.*/, (ws) => ws.close({ code: 1008, reason: "blocked" }));
  }
  return isAllowed;
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

export function createHeadlessRenderer(defaultConfig?: AppConfig, lookup?: LookupFn): HeadlessRenderer {
  let browserPromise: Promise<Browser> | null = null;

  const getBrowser = (): Promise<Browser> => {
    if (!browserPromise) {
      const launching = import("playwright").then((pw) => pw.chromium.launch({ headless: true }));
      browserPromise = launching;
      launching.catch(() => {
        if (browserPromise === launching) browserPromise = null;
      });
    }
    return browserPromise;
  };

  async function renderInContext(context: BrowserContext, url: string, cfg: AppConfig): Promise<RenderResult> {
    const isAllowed = await installGuards(context, lookup);
    const page = await context.newPage();
    const started = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.headlessTimeoutMs });
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
    },
  };
}
