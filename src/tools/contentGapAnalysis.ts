import { contentGapInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const contentGapAnalysisTool: ToolDefinition<typeof contentGapInputSchema> = {
  name: "content_gap_analysis",
  title: "Content gap analysis",
  description:
    "Compare your content (URL or raw_text) against competitor URLs to find missing keywords, heading gaps, and similarity scores.",
  schema: contentGapInputSchema,
  handler: (raw, services, config) =>
    runTool(contentGapInputSchema, raw, services, config, (input) => services.gap(input)),
};
