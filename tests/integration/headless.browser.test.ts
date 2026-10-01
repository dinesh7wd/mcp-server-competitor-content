import { chromium } from "playwright";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createHeadlessRenderer, type UpstreamFetch } from "../../src/infrastructure/headlessRenderer.js";
import type { LookupFn } from "../../src/utils/validators.js";

const browserInstalled = await chromium.launch({ headless: true }).then(
  async (b) => {
    await b.close();
    return true;
  },
  () => false,
);

const lookup: LookupFn = async (host) => [
  { address: host.startsWith("internal") ? "10.0.0.5" : "93.184.216.34", family: 4 },
];

const PAGE = `<!doctype html><html><body>
<link rel="preconnect" href="http://10.0.0.1">
<img src="https://cdn.public.test/hero.png">
<p>static</p>
<script>
  fetch("http://internal.test/secret").catch(() => {});
  fetch("https://api.public.test/data")
    .then((r) => r.text())
    .then((t) => document.body.insertAdjacentHTML("beforeend", "<p id=api>" + t + "</p>"));
</script>
</body></html>`;

const upstream = vi.fn<UpstreamFetch>(async (url) => {
  if (url === "https://public.test/start") {
    return { status: 302, headers: { location: "https://public.test/page" }, body: Buffer.alloc(0) };
  }
  if (url === "https://public.test/page") {
    return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(PAGE) };
  }
  if (url === "https://api.public.test/data") {
    return {
      status: 200,
      headers: { "content-type": "text/plain", "access-control-allow-origin": "*" },
      body: Buffer.from("API-OK"),
    };
  }
  return { status: 404, headers: {}, body: Buffer.alloc(0) };
});

describe.skipIf(!browserInstalled)("headless renderer in real Chromium", () => {
  const renderer = createHeadlessRenderer(loadConfig({ ...process.env, HEADLESS_TIMEOUT_MS: "15000" }), lookup, upstream);
  afterAll(async () => renderer.close?.());

  it("serves the page, redirects and XHR only through the upstream; Chromium itself has no network", async () => {
    const out = await renderer.render("https://public.test/start");
    expect(typeof out === "object" && out.finalUrl).toBe("https://public.test/page");
    const html = typeof out === "string" ? out : out.html;
    expect(html).toContain("API-OK");

    const fetched = upstream.mock.calls.map(([u]) => u);
    expect(fetched).toEqual(
      expect.arrayContaining(["https://public.test/start", "https://public.test/page", "https://api.public.test/data"]),
    );
    expect(fetched.some((u) => u.includes("internal.test") || u.endsWith(".png") || u.includes("10.0.0.1"))).toBe(false);
  }, 30_000);
});
