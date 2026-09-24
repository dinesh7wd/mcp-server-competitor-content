import { compareHeadingsInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const compareHeadingsTool: ToolDefinition<typeof compareHeadingsInputSchema> = {
  name: "compare_headings",
  title: "Compare headings",
  description: "Diff H1–H6 outlines across multiple competitor URLs.",
  schema: compareHeadingsInputSchema,
  handler: (raw, services, config) =>
    runTool(compareHeadingsInputSchema, raw, services, config, (input) => services.headings(input)),
};
