import { serpFeaturesInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const serpFeaturesTool: ToolDefinition<typeof serpFeaturesInputSchema> = {
  name: "serp_features",
  title: "SERP features",
  description:
    "Organic results, People Also Ask, and related searches via SerpApi (requires SERP_PROVIDER=serpapi and SERP_API_KEY). Does not scrape Google HTML.",
  schema: serpFeaturesInputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  handler: (raw, services, config) =>
    runTool(serpFeaturesInputSchema, raw, services, config, (input) => services.serp(input)),
};
