import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  ProgressNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { toolContext } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { createServer, type ServerInstance } from "../../src/server.js";
import type { ContentFetcher, ScrapedPage } from "../../src/infrastructure/contentFetcher.js";

const page: ScrapedPage = {
  url: "https://a.com",
  finalUrl: "https://a.com",
  title: "A",
  metaDescription: "",
  headings: [],
  bodyText: "Running shoes marathon cushioning training race day footwear.",
  textTruncated: false,
  html: "",
  wordCount: 8,
  internalLinks: 0,
  externalLinks: 0,
  images: 0,
  hasSchema: false,
  schemaTypes: [],
  brandMentions: [],
  outboundHosts: [],
  usedHeadless: false,
};

function collectPropertyDescriptions(schema: unknown, path: string, missing: string[]): void {
  if (!schema || typeof schema !== "object") return;
  const node = schema as Record<string, unknown>;
  const props = node.properties as Record<string, Record<string, unknown>> | undefined;
  for (const [name, prop] of Object.entries(props ?? {})) {
    if (typeof prop.description !== "string") missing.push(`${path}.${name}`);
    collectPropertyDescriptions(prop, `${path}.${name}`, missing);
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = node[key] as unknown[] | undefined;
    variants?.forEach((v, i) => collectPropertyDescriptions(v, `${path}.${key}[${i}]`, missing));
  }
  if (node.items) collectPropertyDescriptions(node.items, `${path}[]`, missing);
}

describe("MCP server over in-memory transport", () => {
  let instance: ServerInstance;
  let client: Client;
  const fetcher: ContentFetcher = { fetchPage: vi.fn(async () => page) };

  beforeAll(async () => {
    instance = createServer(loadConfig(process.env), {
      fetcher,
      headless: { render: vi.fn(), close: vi.fn(async () => undefined) },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([instance.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await instance.close();
  });

  it("lists all eight tools with read-only, open-world annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cluster_competitors",
      "compare_headings",
      "content_gap_analysis",
      "content_quality_score",
      "extract_keywords",
      "readability_score",
      "scrape_page",
      "serp_features",
    ]);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(tool.title, tool.name).toBeTruthy();
    }
  });

  it("publishes self-contained schemas with a description on every property", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain("$ref");
      const missing: string[] = [];
      collectPropertyDescriptions(tool.inputSchema, tool.name, missing);
      expect(missing).toEqual([]);
    }
    const scrape = tools.find((t) => t.name === "scrape_page");
    expect(scrape?.inputSchema.properties).toHaveProperty("maxChars");
  });

  it("calls a tool end to end and returns compact JSON", async () => {
    const result = await client.callTool({
      name: "readability_score",
      arguments: { text: "This is a simple sentence. Another sentence follows for testing readability metrics." },
    });
    const content = result.content as { type: string; text: string }[];
    expect(result.isError).toBeFalsy();
    expect(content[0]?.text).not.toContain("\n");
    expect(JSON.parse(content[0]?.text ?? "{}")).toHaveProperty("fleschKincaidGrade");
  });

  it("sends progress notifications for multi-URL tools when a progressToken is present", async () => {
    const cases = [
      { name: "compare_headings", arguments: { urls: ["https://a.com", "https://b.com"] } },
      {
        name: "content_gap_analysis",
        arguments: {
          yourContent: { type: "url", value: "https://a.com" },
          competitorUrls: ["https://b.com", "https://c.com"],
        },
      },
      {
        name: "cluster_competitors",
        arguments: { urls: ["https://a.com", "https://b.com", "https://c.com"], k: 2 },
      },
    ];
    for (const call of cases) {
      const events: { progress: number; total?: number | undefined; message?: string | undefined }[] = [];
      const result = await client.callTool(call, CallToolResultSchema, {
        onprogress: (p) => events.push(p),
      });
      const total = events[0]?.total ?? 0;
      expect(result.isError, call.name).toBeFalsy();
      expect(total, call.name).toBeGreaterThan(0);
      expect(events.map((e) => e.progress), call.name).toEqual(
        Array.from({ length: total }, (_, i) => i + 1),
      );
      expect(events[0]?.message, call.name).toMatch(/^Fetched 1\//);
    }
  });

  it("sends no progress without a progressToken", async () => {
    const events: unknown[] = [];
    client.setNotificationHandler(ProgressNotificationSchema, (n) => void events.push(n));
    await client.callTool({ name: "compare_headings", arguments: { urls: ["https://a.com", "https://b.com"] } });
    expect(events).toEqual([]);
  });

  it("returns tool errors as isError results", async () => {
    const result = await client.callTool({
      name: "extract_keywords",
      arguments: { url: "https://a.com", text: "both url and text supplied here" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("toolContext", () => {
  it("swallows notification send failures", async () => {
    const sendNotification = vi.fn(async () => {
      throw new Error("transport closed");
    });
    const ctx = toolContext({ _meta: { progressToken: "t1" }, sendNotification });
    await expect(ctx.reportProgress?.(1, 2, "x")).resolves.toBeUndefined();
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: { progressToken: "t1", progress: 1, total: 2, message: "x" },
    });
    expect(toolContext({ sendNotification }).reportProgress).toBeUndefined();
  });
});
