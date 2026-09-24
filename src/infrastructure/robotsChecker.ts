import type { AppConfig } from "../config.js";
import type { LruCache } from "./cache.js";
import type { HttpClient } from "./httpClient.js";

export interface RobotsRules {
  readonly disallow: readonly string[];
  readonly allow: readonly string[];
}

export interface RobotsChecker {
  isAllowed(url: string): Promise<boolean>;
}

function parseRobots(body: string, userAgent: string): RobotsRules {
  const lines = body.split(/\r?\n/);
  const agents: Array<{ name: string; disallow: string[]; allow: string[] }> = [];
  let current: { name: string; disallow: string[]; allow: string[] } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      current = { name: value.toLowerCase(), disallow: [], allow: [] };
      agents.push(current);
    } else if (current && key === "disallow") current.disallow.push(value);
    else if (current && key === "allow") current.allow.push(value);
  }
  const ua = userAgent.toLowerCase();
  const match =
    agents.find((a) => a.name !== "*" && ua.includes(a.name.replace(/\*/g, ""))) ||
    agents.find((a) => a.name === "*");
  return match ? { disallow: match.disallow, allow: match.allow } : { disallow: [], allow: [] };
}

function pathAllowed(pathname: string, rules: RobotsRules): boolean {
  const path = pathname || "/";
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const rule of rules.allow) {
    if (rule && path.startsWith(rule)) bestAllow = Math.max(bestAllow, rule.length);
  }
  for (const rule of rules.disallow) {
    if (rule === "") continue;
    if (path.startsWith(rule)) bestDisallow = Math.max(bestDisallow, rule.length);
  }
  if (bestDisallow < 0) return true;
  return bestAllow > bestDisallow;
}

export function createRobotsChecker(
  http: HttpClient,
  config: AppConfig,
  cache: LruCache,
): RobotsChecker {
  return {
    async isAllowed(targetUrl: string): Promise<boolean> {
      if (!config.respectRobotsTxt) return true;
      const url = new URL(targetUrl);
      const cacheKey = `robots:${url.origin}`;
      let rules = cache.get<RobotsRules>(cacheKey);
      if (rules === undefined) {
        try {
          const res = await http.request({
            url: `${url.origin}/robots.txt`,
            timeoutMs: config.httpTimeoutMs,
            retries: 0,
            headers: { "User-Agent": config.userAgent },
          });
          rules =
            res.status >= 200 && res.status < 300
              ? parseRobots(res.body, config.userAgent)
              : { disallow: [], allow: [] };
        } catch {
          rules = { disallow: [], allow: [] };
        }
        cache.set(cacheKey, rules, config.robotsCacheTtlSeconds);
      }
      return pathAllowed(url.pathname, rules);
    },
  };
}

export const __robotsTest = { parseRobots, pathAllowed };
