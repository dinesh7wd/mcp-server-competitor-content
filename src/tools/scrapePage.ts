import { scrapePageInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const scrapePageTool: ToolDefinition<typeof scrapePageInputSchema> = {
  name: "scrape_page",
  title: "Scrape page",
  description: "Fetch and extract clean article body, headings, meta, links, and schema signals from a URL (headless fallback for thin SPA HTML).",
  schema: scrapePageInputSchema,
  handler: (raw, services, config) =>
    runTool(scrapePageInputSchema, raw, services, config, (input) => services.scrape(input)),
};
