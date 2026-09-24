import type { AppConfig } from "../config.js";
import { ErrorCodes, McpError } from "../utils/errors.js";
import type { HttpClient } from "./httpClient.js";

export interface SerpFeatureResult {
  readonly query: string;
  readonly organic: readonly { title: string; link: string; snippet: string }[];
  readonly featuredSnippet?: string;
  readonly peopleAlsoAsk: readonly string[];
  readonly relatedSearches: readonly string[];
  readonly hasVideoCarousel: boolean;
  readonly provider: string;
}

export interface SerpOptions {
  readonly region?: string;
}

export interface SerpProvider {
  getSerpFeatures(query: string, opts?: SerpOptions): Promise<SerpFeatureResult>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function createSerpProvider(http: HttpClient, config: AppConfig): SerpProvider {
  return {
    async getSerpFeatures(query: string, opts?: SerpOptions): Promise<SerpFeatureResult> {
      if (!config.serpProvider || !config.serpApiKey) {
        throw new McpError(
          ErrorCodes.SerpUnconfigured,
          "SERP_PROVIDER and SERP_API_KEY are required for serp_features",
        );
      }
      const region = opts?.region ?? config.serpApiRegion;
      if (config.serpProvider === "serpapi") {
        return serpApi(http, config, query, region);
      }
      if (config.serpProvider === "google_cse") {
        return googleCse(http, config, query);
      }
      return dataForSeo(http, config, query, region);
    },
  };
}

async function serpApi(
  http: HttpClient,
  config: AppConfig,
  query: string,
  region: string,
): Promise<SerpFeatureResult> {
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&engine=google&gl=${encodeURIComponent(region)}&api_key=${config.serpApiKey}`;
  const res = await http.request({ url, timeoutMs: config.httpTimeoutMs, retries: config.httpRetries });
  if (res.status !== 200) {
    throw new McpError(ErrorCodes.ScrapeFail, `SerpApi HTTP ${res.status}`);
  }
  const data = asRecord(JSON.parse(res.body) as unknown);
  const organicRaw = Array.isArray(data.organic_results) ? data.organic_results : [];
  const organic = organicRaw.flatMap((item) => {
    const r = asRecord(item);
    if (typeof r.title !== "string" || typeof r.link !== "string") return [];
    return [{ title: r.title, link: r.link, snippet: typeof r.snippet === "string" ? r.snippet : "" }];
  });
  const paa = Array.isArray(data.related_questions)
    ? data.related_questions.flatMap((q) => {
        const r = asRecord(q);
        return typeof r.question === "string" ? [r.question] : [];
      })
    : [];
  const related = Array.isArray(data.related_searches)
    ? data.related_searches.flatMap((q) => {
        const r = asRecord(q);
        return typeof r.query === "string" ? [r.query] : [];
      })
    : [];
  const answer = asRecord(data.answer_box);
  const featured =
    typeof answer.answer === "string"
      ? answer.answer
      : typeof answer.snippet === "string"
        ? answer.snippet
        : undefined;
  const result: SerpFeatureResult = {
    query,
    organic,
    peopleAlsoAsk: paa,
    relatedSearches: related,
    hasVideoCarousel: Array.isArray(data.video_results) && data.video_results.length > 0,
    provider: "serpapi",
  };
  if (featured !== undefined) return { ...result, featuredSnippet: featured };
  return result;
}

async function googleCse(http: HttpClient, config: AppConfig, query: string): Promise<SerpFeatureResult> {
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${config.serpApiKey}&cx=${encodeURIComponent(config.serpApiRegion)}`;
  const res = await http.request({ url, timeoutMs: config.httpTimeoutMs, retries: config.httpRetries });
  if (res.status !== 200) {
    throw new McpError(ErrorCodes.ScrapeFail, `Google CSE HTTP ${res.status}`);
  }
  const data = asRecord(JSON.parse(res.body) as unknown);
  const items = Array.isArray(data.items) ? data.items : [];
  const organic = items.flatMap((item) => {
    const r = asRecord(item);
    if (typeof r.title !== "string" || typeof r.link !== "string") return [];
    return [{ title: r.title, link: r.link, snippet: typeof r.snippet === "string" ? r.snippet : "" }];
  });
  return {
    query,
    organic,
    peopleAlsoAsk: [],
    relatedSearches: [],
    hasVideoCarousel: false,
    provider: "google_cse",
  };
}

async function dataForSeo(
  http: HttpClient,
  config: AppConfig,
  query: string,
  region: string,
): Promise<SerpFeatureResult> {
  const url = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";
  const res = await http.request({
    url,
    method: "POST",
    timeoutMs: config.httpTimeoutMs,
    retries: config.httpRetries,
    headers: {
      Authorization: `Basic ${config.serpApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ keyword: query, location_code: region, language_code: "en" }]),
  });
  if (res.status !== 200) {
    throw new McpError(ErrorCodes.ScrapeFail, `DataForSEO HTTP ${res.status}`);
  }
  return {
    query,
    organic: [],
    peopleAlsoAsk: [],
    relatedSearches: [],
    hasVideoCarousel: false,
    provider: "dataforseo",
  };
}
