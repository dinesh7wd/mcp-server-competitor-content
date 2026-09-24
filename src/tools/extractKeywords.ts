import { extractKeywordsInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const extractKeywordsTool: ToolDefinition<typeof extractKeywordsInputSchema> = {
  name: "extract_keywords",
  title: "Extract keywords",
  description:
    "Extract ranked keywords and bigrams from a URL or raw text (BM25-style saturation scoring).",
  schema: extractKeywordsInputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  handler: (raw, services, config) =>
    runTool(extractKeywordsInputSchema, raw, services, config, (input) => services.keywords(input)),
};
