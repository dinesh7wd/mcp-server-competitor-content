# mcp-server-competitor-content

MCP server for competitor content analysis: scrape, keywords, content gaps, heading diffs, readability, quality scores, SERP features, and clustering.

**stdio only** — run on your own machine. Do not expose as a remote HTTP MCP endpoint.

## Install

Requires Node.js 22 or newer.

```bash
cd mcp-server-competitor-content
npm install
npm run build
```

For headless SPA fallback:

```bash
npx playwright install chromium
```

> Build before pointing any client at `dist/index.js`. Env vars come from the **client MCP config** (there is no dotenv loader). `.env.example` is a reference only.

## Cursor

```json
{
  "mcpServers": {
    "competitor-content": {
      "command": "node",
      "args": ["D:/MCP/mcp-server-competitor-content/dist/index.js"],
      "env": {
        "LOG_LEVEL": "info",
        "RATE_LIMIT_DELAY_MS": "1000",
        "RESPECT_ROBOTS_TXT": "true",
        "ENABLE_HEADLESS_FALLBACK": "true",
        "SERP_PROVIDER": "serpapi",
        "SERP_API_KEY": "${env:SERP_API_KEY}"
      }
    }
  }
}
```

## Claude Desktop

Add to `claude_desktop_config.json` (absolute path required):

```json
{
  "mcpServers": {
    "competitor-content": {
      "command": "node",
      "args": ["/absolute/path/mcp-server-competitor-content/dist/index.js"],
      "env": {
        "SERP_PROVIDER": "serpapi",
        "SERP_API_KEY": "your-key"
      }
    }
  }
}
```

## Claude Code

```bash
claude mcp add competitor-content -- node /absolute/path/mcp-server-competitor-content/dist/index.js
```

Note: Claude Code caps MCP responses (~25k tokens). `scrape_page` returns at most `maxChars` characters of body text (default 20,000, max 100,000) and sets `truncated: true` when it cuts.

## Tools

| Tool | Description |
|------|-------------|
| `scrape_page` | Clean body (capped by `maxChars`), document-order headings, meta, links, JSON-LD (no raw HTML) |
| `extract_keywords` | Ranked keywords/bigrams from URL or text |
| `content_gap_analysis` | Your `url` or `raw_text` vs competitors (partial results on failures) |
| `compare_headings` | H1–H6 outlines per URL, side by side |
| `readability_score` | Flesch-Kincaid, SMOG, Coleman-Liau |
| `content_quality_score` | Word count, links, media, schema, meta (summary only, no body text) |
| `serp_features` | SerpApi only (`SERP_PROVIDER=serpapi`) |
| `cluster_competitors` | Corpus TF-IDF cosine clustering |

Multi-URL tools fetch up to 3 pages at a time; requests to the same host are still spaced by `RATE_LIMIT_DELAY_MS`. `content_gap_analysis`, `compare_headings`, and `cluster_competitors` send `notifications/progress` (one per fetched page) when the client supplies a `progressToken`.

Pages are decoded using the BOM, then the `Content-Type` charset, then a `<meta charset>` / `http-equiv` tag in the first 2 KB, then UTF-8 (unknown labels fall back to UTF-8). Headless renders wait for `domcontentloaded`, then up to 3 s for network idle within `HEADLESS_TIMEOUT_MS`.

## Security

- Every hostname is resolved and all A/AAAA records must be public (private, loopback, CGNAT, link-local, documentation, benchmark, 6to4 relay `192.88.99.0/24`, and NAT64/6to4/IPv4-mapped forms of those are blocked). IPv6 is an allow-list: only global unicast `2000::/3` passes, minus `2001::/23` (incl. Teredo), `2001:db8::/32` and `3fff::/20`. The HTTP client connects only to the addresses it validated, so DNS rebinding cannot swap in a private IP between check and connect.
- Redirects use `redirect: "manual"` and are re-validated per hop.
- Headless (Playwright) renders are pinned too: Chromium is launched with its own DNS disabled, every request is intercepted and fetched by the same pinned client (redirects followed and re-checked in Node, max 150 requests per render; images, media and fonts skipped), then handed back to the browser. Service workers and WebSockets are blocked and your configured `USER_AGENT` is used.
- robots.txt patterns are matched without regular expressions (linear time), and patterns are capped at 512 characters, so a hostile robots.txt cannot stall the server.
- API keys are stripped from error messages and stderr logs (query strings redacted).
- Response bodies are capped (`MAX_BODY_BYTES`, default 2MB); text capped (`MAX_TEXT_CHARS`).
- `scrape_page` never returns raw HTML; `bodyText` is wrapped as untrusted content.
- robots.txt (RFC 9309): product-token matching, merged groups, case-sensitive `*`/`$` patterns, 4xx → allow, 5xx → deny, unreachable → deny for 60 s, files over 512 KiB truncated and parsed. Redirects to another host are checked against that host's robots.txt.

## Configuration

Set env vars in your MCP client config; see `.env.example` for all of them. `NODE_ENV` defaults to `production`, which hides unexpected internal error messages from clients; set `NODE_ENV=development` locally to see them.

## SERP

Only **SerpApi** is supported. DataForSEO and Google CSE stubs were removed (broken / discontinued).

## Scripts

```bash
npm test
npm run test:coverage   # enforces 80% statements/branches/functions/lines over src/
npm run typecheck       # includes tests
npm run build
npm run lint
```

Logs → **stderr** JSON. stdout reserved for MCP stdio.

## License

MIT
