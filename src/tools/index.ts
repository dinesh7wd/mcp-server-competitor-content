import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import type { AppConfig } from "../config.js";
import type { AppServices } from "../services/index.js";
import { clusterCompetitorsTool } from "./clusterCompetitors.js";
import { compareHeadingsTool } from "./compareHeadings.js";
import { contentGapAnalysisTool } from "./contentGapAnalysis.js";
import { contentQualityScoreTool } from "./contentQualityScore.js";
import { extractKeywordsTool } from "./extractKeywords.js";
import { readabilityScoreTool } from "./readabilityScore.js";
import { scrapePageTool } from "./scrapePage.js";
import { serpFeaturesTool } from "./serpFeatures.js";

export const toolRegistry = [
  scrapePageTool,
  extractKeywordsTool,
  contentGapAnalysisTool,
  compareHeadingsTool,
  readabilityScoreTool,
  contentQualityScoreTool,
  serpFeaturesTool,
  clusterCompetitorsTool,
] as const;

export function registerTools(server: McpServer, services: AppServices, config: AppConfig): void {
  for (const tool of toolRegistry) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: toRawShape(tool.schema),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      async (args) => tool.handler(args, services, config),
    );
  }
}

function toRawShape(schema: z.ZodType): ZodRawShape {
  let current: z.ZodType = schema;
  while (current instanceof z.ZodEffects) {
    current = current._def.schema as z.ZodType;
  }
  if (current instanceof z.ZodObject) {
    return current.shape as ZodRawShape;
  }
  throw new Error("Tool schema must resolve to a Zod object");
}
