import { compareHeadingsInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const compareHeadingsTool: ToolDefinition<typeof compareHeadingsInputSchema> = {
  name: "compare_headings",
  title: "Compare headings",
  description:
    "List the document-order H1–H6 outline of each URL side by side for comparison. Partial results if some URLs fail.",
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
