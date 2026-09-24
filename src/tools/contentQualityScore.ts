import { qualityInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const contentQualityScoreTool: ToolDefinition<typeof qualityInputSchema> = {
  name: "content_quality_score",
  title: "Content quality score",
  description: "Score content quality: word count, links, media, schema, meta, headings.",
  schema: qualityInputSchema,
  handler: (raw, services, config) =>
    runTool(qualityInputSchema, raw, services, config, (input) => services.quality(input)),
};
