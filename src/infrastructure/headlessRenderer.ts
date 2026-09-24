import type { AppConfig } from "../config.js";
import { ErrorCodes, McpError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export interface HeadlessRenderer {
  render(url: string): Promise<string>;
}

/**
 * Playwright-based renderer. Lazy-loads playwright; fails with HEADLESS_RENDER_FAIL if unavailable.
 */
export function createHeadlessRenderer(config: AppConfig): HeadlessRenderer {
  return {
    async render(url: string): Promise<string> {
      try {
        const pw = await import("playwright").catch(() => null);
        if (!pw) {
          throw new McpError(ErrorCodes.HeadlessFail, "playwright is not installed");
        }
        const browser = await pw.chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(url, {
            waitUntil: "networkidle",
            timeout: config.headlessTimeoutMs,
          });
          return await page.content();
        } finally {
          await browser.close();
        }
      } catch (err) {
        if (err instanceof McpError) throw err;
        logger.warn("headless_fail", { url, error: String(err) });
        throw new McpError(
          ErrorCodes.HeadlessFail,
          err instanceof Error ? err.message : "Headless render failed",
        );
      }
    },
  };
}
