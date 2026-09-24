import type { AppConfig } from "../config.js";
import { ErrorCodes, McpError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { redactSecrets, safeUrlForLog } from "../utils/redact.js";
import type { HttpClient } from "./httpClient.js";

export interface SerpOrganic {
  readonly position: number;
  readonly title: string;
  readonly link: string;
  readonly snippet: string;
}

export interface SerpFeatures {
  readonly query: string;
  readonly organic: readonly SerpOrganic[];
  readonly peopleAlsoAsk: readonly string[];
  readonly relatedSearches: readonly string[];
  readonly hasVideoCarousel: boolean;
  readonly provider: "serpapi";
}

export interface SerpProvider {
  getSerpFeatures(
    query: string,
    options?: { region?: string },
  ): Promise<SerpFeatures>;
}

function parseSerpApi(data: unknown, query: string): SerpFeatures {
  const root = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const organicRaw = Array.isArray(root.organic_results) ? root.organic_results : [];
  const organic: SerpOrganic[] = organicRaw
    .map((item, i) => {
      const row = item as Record<string, unknown>;
      return {
        position: typeof row.position === "number" ? row.position : i + 1,
        title: String(row.title ?? ""),
        link: String(row.link ?? ""),
        snippet: String(row.snippet ?? ""),
      };
    })
    .filter((r) => r.link);

  const paa = Array.isArray(root.related_questions)
    ? root.related_questions
        .map((q) => String((q as { question?: string }).question ?? ""))
        .filter(Boolean)
    : [];
  const related = Array.isArray(root.related_searches)
    ? root.related_searches
        .map((q) => String((q as { query?: string }).query ?? ""))
        .filter(Boolean)
    : [];
  const hasVideo = Array.isArray(root.inline_videos) && root.inline_videos.length > 0;

  return {
    query,
    organic,
    peopleAlsoAsk: paa,
    relatedSearches: related,
    hasVideoCarousel: hasVideo,
    provider: "serpapi",
  };
}

export function createSerpProvider(http: HttpClient, config: AppConfig): SerpProvider {
  return {
    async getSerpFeatures(query: string, options = {}): Promise<SerpFeatures> {
      if (config.serpProvider !== "serpapi" || !config.serpApiKey) {
        throw new McpError(
          ErrorCodes.SerpUnconfigured,
          "Set SERP_PROVIDER=serpapi and SERP_API_KEY. DataForSEO and Google CSE are not supported.",
        );
      }

      const region = options.region ?? config.serpApiRegion;
      const url = new URL("https://serpapi.com/search.json");
      url.searchParams.set("engine", "google");
      url.searchParams.set("q", query);
      url.searchParams.set("num", "10");
      url.searchParams.set("gl", region);
      url.searchParams.set("api_key", config.serpApiKey);

      try {
        const res = await http.request({
          url: url.toString(),
          timeoutMs: config.httpTimeoutMs,
          retries: config.httpRetries,
          validateRedirects: true,
          maxBodyBytes: 2 * 1024 * 1024,
        });
        if (res.status >= 400) {
          throw new McpError(
            ErrorCodes.SerpFail,
            `SerpApi HTTP ${res.status} (credentials redacted)`,
          );
        }
        let data: unknown;
        try {
          data = JSON.parse(res.body) as unknown;
        } catch {
          throw new McpError(ErrorCodes.SerpFail, "SerpApi returned invalid JSON");
        }
        return parseSerpApi(data, query);
      } catch (err) {
        if (err instanceof McpError) throw err;
        const msg = err instanceof Error ? redactSecrets(err.message) : "SERP failed";
        logger.error("serp_fail", {
          query,
          error: msg,
          url: safeUrlForLog(url.toString()),
        });
        throw new McpError(ErrorCodes.SerpFail, msg);
      }
    },
  };
}
