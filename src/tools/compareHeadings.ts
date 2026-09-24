import { compareHeadingsInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const compareHeadingsTool: ToolDefinition<typeof compareHeadingsInputSchema> = {
  name: "compare_headings",
  title: "Compare headings",
  description:
    "Diff document-order H1–H6 outlines across competitor URLs. Partial results if some URLs fail.",
  schema: compareHeadingsInputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  handler: (raw, services, config) =>
    runTool(compareHeadingsInputSchema, raw, services, config, (input) => services.headings(input)),
};
