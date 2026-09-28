#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { logger } from "./utils/logger.js";

/** Close Playwright/HTTP pools on exit so no Chromium processes are orphaned. */
function installShutdownHandlers(close: () => Promise<void>): void {
  let closing = false;
  const shutdown = (reason: string): void => {
    if (closing) return;
    closing = true;
    logger.info("shutdown", { reason });
    close()
      .catch((err: unknown) => {
        logger.error("shutdown_error", { message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.once("end", () => shutdown("stdin_end"));
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const { server, close } = createServer(config);
  installShutdownHandlers(close);
  await server.connect(new StdioServerTransport());
  logger.info("competitor-content listening on stdio", {
    serpConfigured: Boolean(config.serpProvider && config.serpApiKey),
    headless: config.enableHeadlessFallback,
  });
}

main().catch((err: unknown) => {
  logger.error("fatal", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
