import { scrapePageInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const scrapePageTool: ToolDefinition<typeof scrapePageInputSchema> = {
  name: "scrape_page",
  title: "Scrape page",
  description:
    "Fetch and extract clean body text, document-order headings, meta, links, and JSON-LD schema from a public URL. Raw HTML is never returned. bodyText is wrapped as untrusted content.",
  schema: scrapePageInputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  handler: (raw, services, config) =>
    runTool(scrapePageInputSchema, raw, services, config, (input) => services.scrape(input)),
};
