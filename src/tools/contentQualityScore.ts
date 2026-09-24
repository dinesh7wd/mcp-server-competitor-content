import { qualityInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const contentQualityScoreTool: ToolDefinition<typeof qualityInputSchema> = {
  name: "content_quality_score",
  title: "Content quality score",
  description:
    "Score on-page quality: word count, links, media, JSON-LD schema, meta description, headings.",
  schema: qualityInputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  handler: (raw, services, config) =>
    runTool(qualityInputSchema, raw, services, config, (input) => services.quality(input)),
};
