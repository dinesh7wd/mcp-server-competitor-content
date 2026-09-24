import { clusterCompetitorsInputSchema } from "../utils/schemas.js";
import { runTool, type ToolDefinition } from "./types.js";

export const clusterCompetitorsTool: ToolDefinition<typeof clusterCompetitorsInputSchema> = {
  name: "cluster_competitors",
  title: "Cluster competitors",
  description: "Group competitor pages by TF-IDF cosine similarity (embeddings optional via config).",
  schema: clusterCompetitorsInputSchema,
  handler: (raw, services, config) =>
    runTool(clusterCompetitorsInputSchema, raw, services, config, (input) => services.cluster(input)),
};
