import { readabilityInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const readabilityScoreTool: ToolDefinition<typeof readabilityInputSchema> = {
  name: "readability_score",
  title: "Readability score",
  description: "Flesch-Kincaid, SMOG, and Coleman-Liau readability metrics for a URL or raw text.",
  schema: readabilityInputSchema,
  handler: (raw, services, config) =>
    runTool(readabilityInputSchema, raw, services, config, (input) => services.readability(input)),
};
