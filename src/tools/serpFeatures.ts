import { serpFeaturesInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const serpFeaturesTool: ToolDefinition<typeof serpFeaturesInputSchema> = {
  name: "serp_features",
  title: "SERP features",
  description:
    "Detect featured snippets, PAA, related searches, and organic results via configured SERP API (never scrapes Google directly).",
  schema: serpFeaturesInputSchema,
  handler: (raw, services, config) =>
    runTool(serpFeaturesInputSchema, raw, services, config, (input) => services.serp(input)),
};
