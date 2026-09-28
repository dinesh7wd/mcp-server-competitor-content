import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import type { AppConfig } from "../config.js";
import type { AppServices } from "../services/index.js";
import type { ToolContext } from "./types.js";
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
      async (args, extra) => tool.handler(args, services, config, toolContext(extra)),
    );
  }
}

type HandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Maps service progress to `notifications/progress`; send failures never fail the tool. */
export function toolContext(extra: Pick<HandlerExtra, "_meta" | "sendNotification">): ToolContext {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return {};
  return {
    reportProgress: (progress, total, message) =>
      extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress, total, message },
        })
        .catch(() => undefined),
  };
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
