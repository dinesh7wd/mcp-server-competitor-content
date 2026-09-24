# mcp-server-competitor-content

MCP server for competitor content analysis: scrape, keywords, content gaps, heading diffs, readability, quality scores, SERP features, and clustering.

**stdio only** — run on your own machine. Do not expose as a remote HTTP MCP endpoint.

## Install

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

Note: Claude Code caps MCP responses (~25k tokens). Prefer tools that return summaries over huge scrapes.

## Tools

| Tool | Description |
|------|-------------|
| `scrape_page` | Clean body, document-order headings, meta, links, JSON-LD (no raw HTML) |
| `extract_keywords` | Ranked keywords/bigrams from URL or text |
| `content_gap_analysis` | Your `url` or `raw_text` vs competitors (partial results on failures) |
| `compare_headings` | H1–H6 outline comparison |
| `readability_score` | Flesch-Kincaid, SMOG, Coleman-Liau |
| `content_quality_score` | Word count, links, media, schema, meta |
| `serp_features` | SerpApi only (`SERP_PROVIDER=serpapi`) |
| `cluster_competitors` | Corpus TF-IDF cosine clustering |

## Security

- DNS is resolved before each fetch; private/loopback/CGNAT/link-local/IPv6 ULA/metadata hosts are blocked.
- Redirects use `redirect: "manual"` and are re-validated per hop.
- Playwright aborts requests to blocked destinations and uses your configured `USER_AGENT`.
- API keys are stripped from error messages and stderr logs (query strings redacted).
- Response bodies are capped (`MAX_BODY_BYTES`, default 2MB); text capped (`MAX_TEXT_CHARS`).
- `scrape_page` never returns raw HTML; `bodyText` is wrapped as untrusted content.
- robots.txt: multi-agent groups, `*`/`$` patterns, 5xx → deny (RFC 9309).

## SERP

Only **SerpApi** is supported. DataForSEO and Google CSE stubs were removed (broken / discontinued).

## Scripts

```bash
npm test
npm run test:coverage
npm run build
npm run lint
```

Logs → **stderr** JSON. stdout reserved for MCP stdio.

## License

MIT
