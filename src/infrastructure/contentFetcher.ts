import * as cheerio from "cheerio";
import type { AppConfig } from "../config.js";
import { ErrorCodes, McpError } from "../utils/errors.js";
import { normalizeWhitespace } from "../utils/textHelpers.js";
import { assertPublicHttpUrl } from "../utils/validators.js";
import type { LruCache } from "./cache.js";
import type { HeadlessRenderer } from "./headlessRenderer.js";
import type { HttpClient } from "./httpClient.js";
import type { DomainRateLimiter } from "./rateLimiter.js";
import type { RobotsChecker } from "./robotsChecker.js";

export interface ScrapedPage {
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly metaDescription: string;
  readonly headings: readonly { level: number; text: string }[];
  readonly bodyText: string;
  readonly html: string;
  readonly wordCount: number;
  readonly internalLinks: number;
  readonly externalLinks: number;
  readonly images: number;
  readonly hasSchema: boolean;
  readonly brandMentions: readonly string[];
  readonly outboundHosts: readonly string[];
  readonly usedHeadless: boolean;
}

export interface ContentFetcher {
  fetchPage(url: string, opts?: { forceHeadless?: boolean }): Promise<ScrapedPage>;
}

function extractFromHtml(url: string, finalUrl: string, html: string, usedHeadless: boolean): ScrapedPage {
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, svg").remove();
  const title = normalizeWhitespace($("title").first().text() || $("h1").first().text());
  const metaDescription = normalizeWhitespace(
    $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      "",
  );
  const headings: { level: number; text: string }[] = [];
  for (let level = 1; level <= 6; level += 1) {
    $(`h${level}`).each((_, el) => {
      const text = normalizeWhitespace($(el).text());
      if (text) headings.push({ level, text });
    });
  }
  const article = $("article").text() || $("main").text() || $("body").text();
  const bodyText = normalizeWhitespace(article);
  const origin = new URL(finalUrl).origin;
  let internalLinks = 0;
  let externalLinks = 0;
  const outboundHosts = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const abs = new URL(href, finalUrl);
      if (abs.origin === origin) internalLinks += 1;
      else {
        externalLinks += 1;
        outboundHosts.add(abs.hostname);
      }
    } catch {
      /* ignore */
    }
  });
  const images = $("img").length;
  const hasSchema =
    $('script[type="application/ld+json"]').length > 0 || $("[itemscope]").length > 0;
  const brandMentions: string[] = [];
  const lower = bodyText.toLowerCase();
  for (const brand of ["google", "amazon", "microsoft", "meta", "openai", "shopify"]) {
    if (lower.includes(brand)) brandMentions.push(brand);
  }
  return {
    url,
    finalUrl,
    title,
    metaDescription,
    headings,
    bodyText,
    html,
    wordCount: bodyText ? bodyText.split(/\s+/).length : 0,
    internalLinks,
    externalLinks,
    images,
    hasSchema,
    brandMentions,
    outboundHosts: [...outboundHosts],
    usedHeadless,
  };
}

export function createContentFetcher(deps: {
  http: HttpClient;
  cache: LruCache;
  robots: RobotsChecker;
  rateLimiter: DomainRateLimiter;
  headless: HeadlessRenderer;
  config: AppConfig;
}): ContentFetcher {
  const { http, cache, robots, rateLimiter, headless, config } = deps;
  return {
    async fetchPage(rawUrl: string, opts?: { forceHeadless?: boolean }): Promise<ScrapedPage> {
      const url = assertPublicHttpUrl(rawUrl);
      const cacheKey = `page:${url.href}:${opts?.forceHeadless === true}`;
      const cached = cache.get<ScrapedPage>(cacheKey);
      if (cached) return cached;

      const allowed = await robots.isAllowed(url.href);
      if (!allowed) {
        throw new McpError(ErrorCodes.RobotsDisallowed, `robots.txt disallows ${url.pathname}`);
      }

      await rateLimiter.wait(url.hostname);

      let html = "";
      let usedHeadless = false;
      const finalUrl = url.href;

      if (opts?.forceHeadless === true && config.enableHeadlessFallback) {
        html = await headless.render(url.href);
        usedHeadless = true;
      } else {
        const res = await http.request({
          url: url.href,
          timeoutMs: config.httpTimeoutMs,
          retries: config.httpRetries,
          headers: {
            "User-Agent": config.userAgent,
            Accept: "text/html,application/xhtml+xml",
          },
        });
        if (res.status < 200 || res.status >= 400) {
          throw new McpError(ErrorCodes.ScrapeFail, `HTTP ${res.status} for ${url.href}`);
        }
        html = res.body;
        const page = extractFromHtml(url.href, finalUrl, html, false);
        if (
          config.enableHeadlessFallback &&
          page.bodyText.length < config.headlessMinContentChars
        ) {
          try {
            html = await headless.render(url.href);
            usedHeadless = true;
          } catch {
            if (page.bodyText.length === 0) {
              throw new McpError(ErrorCodes.NoContent, "Empty content after static and headless fetch");
            }
            cache.set(cacheKey, page);
            return page;
          }
        } else {
          cache.set(cacheKey, page);
          return page;
        }
      }

      const page = extractFromHtml(url.href, finalUrl, html, usedHeadless);
      if (page.bodyText.length === 0) {
        throw new McpError(ErrorCodes.NoContent, "No extractable content");
      }
      cache.set(cacheKey, page);
      return page;
    },
  };
}
