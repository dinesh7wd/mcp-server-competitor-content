import { extractKeywordsInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const extractKeywordsTool: ToolDefinition<typeof extractKeywordsInputSchema> = {
  name: "extract_keywords",
  title: "Extract keywords",
  description: "Extract TF-IDF keywords and bigrams from a URL or raw text.",
  schema: extractKeywordsInputSchema,
  handler: (raw, services, config) =>
    runTool(extractKeywordsInputSchema, raw, services, config, (input) => services.keywords(input)),
};
