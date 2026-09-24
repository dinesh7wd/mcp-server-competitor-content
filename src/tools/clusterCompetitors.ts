import { clusterCompetitorsInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const clusterCompetitorsTool: ToolDefinition<typeof clusterCompetitorsInputSchema> = {
  name: "cluster_competitors",
  title: "Cluster competitors",
  description:
    "Group competitor pages by corpus TF-IDF cosine similarity (farthest-first k-means seeds). Partial results if some URLs fail.",
  schema: clusterCompetitorsInputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  handler: (raw, services, config) =>
    runTool(clusterCompetitorsInputSchema, raw, services, config, (input) =>
      services.cluster(input),
    ),
};
