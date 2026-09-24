import type { AppConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { safeUrlForLog } from "../utils/redact.js";
import type { LruCache } from "./cache.js";
import type { HttpClient } from "./httpClient.js";

export interface RobotsChecker {
  isAllowed(url: string, userAgent?: string): Promise<boolean>;
}

interface RuleGroup {
  readonly agents: readonly string[];
  readonly allows: readonly string[];
  readonly disallows: readonly string[];
}

function pathMatches(pattern: string, path: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") regex += ".*";
    else if (ch === "$" && i === pattern.length - 1) regex += "$";
    else if (ch === "$") regex += "\\$";
    else if (/[.+?^${}()|[\]\\]/.test(ch!)) regex += `\\${ch}`;
    else regex += ch;
  }
  if (!pattern.endsWith("$")) regex += ".*";
  try {
    return new RegExp(regex, "i").test(path);
  } catch {
    return path.startsWith(pattern);
  }
}

function longestMatch(patterns: readonly string[], path: string): number {
  let best = -1;
  for (const p of patterns) {
    if (p === "") continue;
    if (pathMatches(p, path)) best = Math.max(best, p.length);
  }
  return best;
}

/** Parse robots.txt with multi-agent groups (shared Allow/Disallow). */
export function parseRobotsTxt(text: string): RuleGroup[] {
  const groups: RuleGroup[] = [];
  let agents: string[] = [];
  let allows: string[] = [];
  let disallows: string[] = [];
  let inGroup = false;

  const flush = (): void => {
    if (agents.length > 0) {
      groups.push({ agents: [...agents], allows: [...allows], disallows: [...disallows] });
    }
    agents = [];
    allows = [];
    disallows = [];
    inGroup = false;
  };

  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      if (inGroup && (allows.length > 0 || disallows.length > 0)) {
        flush();
      }
      agents.push(value.toLowerCase());
      inGroup = true;
    } else if (key === "allow") {
      allows.push(value);
      inGroup = true;
    } else if (key === "disallow") {
      disallows.push(value);
      inGroup = true;
    }
  }
  flush();
  return groups;
}

export function isPathAllowed(
  groups: readonly RuleGroup[],
  userAgent: string,
  pathAndQuery: string,
): boolean {
  const ua = userAgent.toLowerCase();
  const path = pathAndQuery || "/";

  const matching = groups.filter((g) =>
    g.agents.some((a) => a === "*" || ua.includes(a) || a.includes(ua)),
  );
  matching.sort((a, b) => {
    const score = (g: RuleGroup): number =>
      Math.max(...g.agents.map((x) => (x === "*" ? 0 : x.length)));
    return score(b) - score(a);
  });

  const group = matching[0];
  if (!group) return true;

  if (group.disallows.length === 0) return true;
  if (group.disallows.every((d) => d === "")) return true;

  const allowLen = longestMatch(group.allows, path);
  const disallowLen = longestMatch(group.disallows, path);

  if (disallowLen < 0 && allowLen < 0) return true;
  if (allowLen >= disallowLen) return true;
  return false;
}

/** Test helpers matching previous __robotsTest API. */
export const __robotsTest = {
  parseRobots(text: string, _userAgent: string): RuleGroup[] {
    return parseRobotsTxt(text);
  },
  pathAllowed(path: string, groups: RuleGroup[]): boolean {
    return isPathAllowed(groups, "*", path);
  },
};

export function createRobotsChecker(
  http: HttpClient,
  config: AppConfig,
  cache: LruCache,
): RobotsChecker {
  return {
    async isAllowed(url: string, userAgent = config.userAgent): Promise<boolean> {
      if (!config.respectRobotsTxt) return true;

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }
      const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;
      const cacheKey = `robots:${robotsUrl}`;
      type Cached = { status: "ok" | "deny_all" | "allow_all"; groups: RuleGroup[] };
      let cached = cache.get<Cached>(cacheKey);

      if (!cached) {
        try {
          const res = await http.request({
            url: robotsUrl,
            timeoutMs: Math.min(config.httpTimeoutMs, 10_000),
            retries: 1,
            validateRedirects: true,
            maxBodyBytes: 512 * 1024,
            headers: { "User-Agent": config.userAgent },
          });
          if (res.status >= 500) {
            logger.warn("robots_5xx_deny", {
              url: safeUrlForLog(robotsUrl),
              status: res.status,
            });
            cached = { status: "deny_all", groups: [] };
          } else if (res.status === 404 || res.status === 410) {
            cached = { status: "allow_all", groups: [] };
          } else if (res.status >= 400) {
            cached = { status: "allow_all", groups: [] };
          } else {
            cached = { status: "ok", groups: parseRobotsTxt(res.body) };
          }
        } catch (err) {
          logger.warn("robots_fetch_fail_deny", {
            url: safeUrlForLog(robotsUrl),
            error: err instanceof Error ? err.message : "fail",
          });
          cached = { status: "deny_all", groups: [] };
        }
        cache.set(cacheKey, cached, config.robotsCacheTtlSeconds);
      }

      if (cached.status === "deny_all") return false;
      if (cached.status === "allow_all") return true;
      const path = parsed.pathname + (parsed.search || "");
      return isPathAllowed(cached.groups, userAgent, path);
    },
  };
}
