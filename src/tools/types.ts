import { ZodError, type z } from "zod";
import type { AppConfig } from "../config.js";
import type { AppServices } from "../services/index.js";
import { ErrorCodes, isMcpError, McpError, toMcpError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { zodToErrorMessage } from "../utils/schemas.js";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean | undefined;
}

export interface ToolDefinition<T extends z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schema: T;
  readonly handler: (raw: unknown, services: AppServices, config: AppConfig) => Promise<ToolResult>;
}

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(err: unknown, nodeEnv: AppConfig["nodeEnv"]): ToolResult {
  const mapped = toMcpError(err);
  if (isMcpError(err)) {
    logger.warn("tool_error", { code: mapped.code, message: mapped.message });
    return { content: [{ type: "text", text: JSON.stringify(mapped.toJSON()) }], isError: true };
  }
  logger.error("unhandled_tool_error", { message: mapped.message });
  const payload =
    nodeEnv === "production"
      ? { code: "InternalError", message: "Internal error" }
      : mapped.toJSON();
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
}

export async function runTool<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  services: AppServices,
  config: AppConfig,
  run: (input: z.output<S>) => Promise<unknown> | unknown,
): Promise<ToolResult> {
  try {
    const input = schema.parse(raw) as z.output<S>;
    return ok(await run(input));
  } catch (err) {
    if (err instanceof ZodError) {
      return fail(new McpError(ErrorCodes.InvalidParams, zodToErrorMessage(err)), config.nodeEnv);
    }
    return fail(err, config.nodeEnv);
  }
}
