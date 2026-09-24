import { contentGapInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const contentGapAnalysisTool: ToolDefinition<typeof contentGapInputSchema> = {
  name: "content_gap_analysis",
  title: "Content gap analysis",
  description:
    "Compare your content against competitor URLs for missing keywords, heading gaps, and similarity. Failed competitor URLs are reported in errors; others still return.",
  schema: contentGapInputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  handler: (raw, services, config) =>
    runTool(contentGapInputSchema, raw, services, config, (input) => services.gap(input)),
};
