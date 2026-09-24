# mcp-server-competitor-content

MCP server for competitor content analysis: scrape, keywords, content gaps, heading diffs, readability, quality scores, SERP features, and clustering.

## Install

```bash
cd mcp-server-competitor-content
npm install
npm run build
```

> Run `npm run build` before pointing Cursor at `dist/index.js`.

## Cursor MCP config

Update the path for your machine:

```json
{
  "mcpServers": {
    "competitor-content": {
      "command": "node",
      "args": ["/path/to/mcp-server-competitor-content/dist/index.js"],
      "env": {
        "LOG_LEVEL": "info",
        "RATE_LIMIT_DELAY_MS": "1000",
        "RESPECT_ROBOTS_TXT": "true",
        "ENABLE_HEADLESS_FALLBACK": "true",
        "SERP_PROVIDER": "serpapi",
        "SERP_API_KEY": "your-key"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `scrape_page` | Extract body, headings, meta, links, schema (Playwright fallback if thin SPA HTML) |
| `extract_keywords` | TF-IDF keywords/bigrams from URL or text |
| `content_gap_analysis` | Your content as `url` **or** `raw_text` vs competitor URLs |
| `compare_headings` | H1–H6 outline comparison |
| `readability_score` | Flesch-Kincaid, SMOG, Coleman-Liau |
| `content_quality_score` | Word count, links, media, schema, meta |
| `serp_features` | Featured snippet, PAA, related searches via SerpApi/DataForSEO/CSE (**not** Google scraping) |
| `cluster_competitors` | TF-IDF cosine clustering (optional embeddings via config) |

## Patched blueprint gaps

1. **SERP** — `serpProvider.ts`; fails with `SERP_PROVIDER_UNCONFIGURED` if unset  
2. **Headless** — Playwright only when static body &lt; `HEADLESS_MIN_CONTENT_CHARS`  
3. **robots.txt** — parsed ruleset cached per domain (`ROBOTS_CACHE_TTL_SECONDS`)  
4. **Embeddings** — optional; default clustering is TF-IDF  
5. **Gap analysis input** — `yourContent: { type: "url"|"raw_text", value }`

## Scripts

```bash
npm test
npm run test:coverage
npm run build
npm run dev
```

Logs → **stderr** JSON. stdout reserved for MCP stdio.

## License

MIT
