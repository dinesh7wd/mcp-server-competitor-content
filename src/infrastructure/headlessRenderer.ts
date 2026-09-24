import type { AppConfig } from "../config.js";
import { ErrorCodes, McpError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { safeUrlForLog } from "../utils/redact.js";
import { assertSafeHttpUrl } from "../utils/validators.js";

export interface RenderResult {
  readonly html: string;
  readonly finalUrl: string;
}

export interface HeadlessRenderer {
  render(url: string, config?: AppConfig): Promise<string | RenderResult>;
  close?(): Promise<void>;
}

export function createHeadlessRenderer(_defaultConfig?: AppConfig): HeadlessRenderer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;

  return {
    async render(url: string, config?: AppConfig): Promise<RenderResult> {
      const cfg = config ?? _defaultConfig;
      if (!cfg) {
        throw new McpError(ErrorCodes.HeadlessFail, "Headless config missing");
      }
      await assertSafeHttpUrl(url);
      try {
        const playwright = await import("playwright");
        if (!browser) {
          browser = await playwright.chromium.launch({ headless: true });
        }
        const context = await browser.newContext({
          userAgent: cfg.userAgent,
          javaScriptEnabled: true,
        });
        const page = await context.newPage();

        await page.route("**/*", async (route: {
          request: () => { url: () => string };
          abort: () => Promise<void>;
          continue: () => Promise<void>;
        }) => {
          const reqUrl = route.request().url();
          try {
            await assertSafeHttpUrl(reqUrl);
            await route.continue();
          } catch {
            await route.abort();
          }
        });

        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: cfg.headlessTimeoutMs,
        });
        if (response) {
          await assertSafeHttpUrl(response.url());
        }
        const html = await page.content();
        const finalUrl = page.url();
        await assertSafeHttpUrl(finalUrl);
        await context.close();
        return { html, finalUrl };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "headless render failed";
        logger.error("headless_fail", { url: safeUrlForLog(url), error: msg });
        if (msg.includes("Executable doesn't exist") || msg.includes("browserType.launch")) {
          throw new McpError(
            ErrorCodes.HeadlessFail,
            "Playwright browser missing. Run: npx playwright install chromium",
          );
        }
        if (err instanceof McpError) throw err;
        throw new McpError(ErrorCodes.HeadlessFail, msg);
      }
    },
    async close(): Promise<void> {
      if (browser) {
        await browser.close();
        browser = null;
      }
    },
  };
}
