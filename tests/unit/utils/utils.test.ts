import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../../src/config.js";
import { fail, ok, runTool } from "../../../src/tools/types.js";
import { mapWithConcurrency } from "../../../src/utils/concurrency.js";
import { ErrorCodes, McpError, toMcpError } from "../../../src/utils/errors.js";
import { logger, setLogLevel } from "../../../src/utils/logger.js";
import { redactExtra } from "../../../src/utils/redact.js";
import type { AppServices } from "../../../src/services/index.js";

afterEach(() => {
  setLogLevel("error");
  vi.restoreAllMocks();
});

describe("redactExtra", () => {
  it("redacts nested objects and arrays and strips URL queries", () => {
    const out = redactExtra({
      url: "https://x.com/p?api_key=S1",
      nested: { detail: "call ?token=S2 failed", inner: { href: "https://y.com/?key=S3" } },
      list: ["Bearer S4", { message: "Basic S5=" }],
      count: 3,
      empty: null,
    });
    const text = JSON.stringify(out);
    for (const secret of ["S1", "S2", "S3", "S4", "S5"]) expect(text).not.toContain(secret);
    expect(out.count).toBe(3);
    expect(out.empty).toBeNull();
  });

  it("stops at the depth limit", () => {
    const deep = { a: { b: { c: { d: { e: { f: "?token=DEEP" } } } } } };
    expect(JSON.stringify(redactExtra(deep))).not.toContain("DEEP");
  });
});

describe("logger", () => {
  it("filters by level and writes redacted JSON to stderr", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setLogLevel("warn");
    logger.info("hidden");
    logger.debug("hidden");
    logger.warn("shown", { url: "https://x.com/?api_key=SECRET" });
    logger.error("plain");
    expect(write).toHaveBeenCalledTimes(2);
    expect(String(write.mock.calls[0]?.[0])).not.toContain("SECRET");
  });
});

describe("errors", () => {
  it("redacts McpError messages and wraps unknown errors", () => {
    const e = new McpError(ErrorCodes.ScrapeFail, "x", { a: 1 });
    expect(toMcpError(e)).toBe(e);
    expect(e.toJSON()).toEqual({ code: ErrorCodes.ScrapeFail, message: "x", details: { a: 1 } });
    const leaky = toMcpError(new McpError(ErrorCodes.ScrapeFail, "?api_key=S", { a: 1 }));
    expect(leaky.message).toContain("REDACTED");
    expect(leaky.details).toEqual({ a: 1 });
    expect(toMcpError("boom")).toMatchObject({ code: ErrorCodes.InternalError, message: "boom" });
  });
});

describe("tool result helpers", () => {
  const services = {} as AppServices;
  const config = loadConfig(process.env);

  it("serializes results without indentation", () => {
    expect(ok({ a: { b: 1 } }).content[0]?.text).toBe('{"a":{"b":1}}');
  });

  it("masks unexpected errors in production only", () => {
    const prod = fail(new Error("db password leaked"), "production");
    expect(prod.content[0]?.text).toContain("Internal error");
    const dev = fail(new Error("details ?token=T"), "development");
    expect(dev.content[0]?.text).toContain("details");
    expect(dev.content[0]?.text).not.toContain("=T");
    expect(fail(new McpError(ErrorCodes.SsrfBlocked, "no"), "production").content[0]?.text).toContain(
      ErrorCodes.SsrfBlocked,
    );
  });

  it("returns InvalidParams for schema errors", async () => {
    const res = await runTool(z.object({ n: z.number() }), { n: "x" }, services, config, () => 1);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("InvalidParams");
  });
});

describe("mapWithConcurrency", () => {
  it("keeps order and respects the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 3, 2, 4], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
    expect(await mapWithConcurrency([], 3, async (n: number) => n)).toEqual([]);
  });
});
