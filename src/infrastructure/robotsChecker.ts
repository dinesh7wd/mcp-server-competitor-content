import type { AppConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { safeUrlForLog } from "../utils/redact.js";
import type { LruCache } from "./cache.js";
import type { HttpClient } from "./httpClient.js";

export interface RobotsChecker {
  isAllowed(url: string, userAgent?: string): Promise<boolean>;
}

export interface RuleGroup {
  readonly agents: readonly string[];
  readonly allows: readonly string[];
  readonly disallows: readonly string[];
}

/** RFC 9309 §2.5: parse at least 500 KiB; larger files are truncated, not rejected. */
export const ROBOTS_MAX_BYTES = 512 * 1024;
/** Short-lived deny for unreachable robots.txt so transient failures don't block a host for long. */
export const ROBOTS_UNREACHABLE_TTL_SECONDS = 60;

/** Robots matching uses the product token only: "Foo-Bot/1.2 (+url)" → "foo-bot". */
export function productToken(userAgent: string): string {
  return (userAgent.split("/")[0] ?? "").trim().toLowerCase();
}

/**
 * Longer Disallow patterns are cut to a prefix (a broader, stricter match); longer Allow
 * patterns are dropped. Keeps matching cost bounded without ever loosening a restriction.
 */
export const MAX_ROBOTS_PATTERN_LENGTH = 512;

/**
 * Matches a robots.txt path pattern (`*` wildcard, trailing `$` anchor) without regular
 * expressions: literal segments are located left to right with indexOf, so the cost is
 * linear in path + pattern length and hostile patterns cannot cause catastrophic backtracking.
 */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const segments = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = segments[0]!;
  if (!path.startsWith(first)) return false;
  if (segments.length === 1) return !anchored || path.length === first.length;

  let pos = first.length;
  for (let i = 1; i < segments.length - 1; i += 1) {
    const seg = segments[i]!;
    if (!seg) continue;
    const idx = path.indexOf(seg, pos);
    if (idx === -1) return false;
    pos = idx + seg.length;
  }
  const last = segments[segments.length - 1]!;
  if (!anchored) return !last || path.indexOf(last, pos) !== -1;
  return path.length - last.length >= pos && path.endsWith(last);
}

function longestMatch(patterns: readonly string[], path: string): number {
  let best = -1;
  for (const p of patterns) {
    if (p !== "" && robotsPatternMatches(p, path)) best = Math.max(best, p.length);
  }
  return best;
}

/** Parse robots.txt into groups; consecutive user-agent lines share one rule set. */
export function parseRobotsTxt(text: string): RuleGroup[] {
  const groups: RuleGroup[] = [];
  let current: { agents: string[]; allows: string[]; disallows: string[] } | null = null;

  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      const agent = value === "*" ? "*" : productToken(value);
      if (!agent) continue;
      if (!current || current.allows.length > 0 || current.disallows.length > 0) {
        current = { agents: [], allows: [], disallows: [] };
        groups.push(current);
      }
      current.agents.push(agent);
    } else if (current && key === "allow") {
      if (value.length <= MAX_ROBOTS_PATTERN_LENGTH) current.allows.push(value);
    } else if (current && key === "disallow") {
      current.disallows.push(value.slice(0, MAX_ROBOTS_PATTERN_LENGTH));
    }
  }
  return groups;
}

/** Merge every group naming our product token; fall back to all `*` groups (RFC 9309 §2.2.1). */
export function selectRules(groups: readonly RuleGroup[], userAgent: string): RuleGroup | undefined {
  const token = userAgent === "*" ? "*" : productToken(userAgent);
  let matching = groups.filter((g) => g.agents.includes(token));
  if (matching.length === 0) matching = groups.filter((g) => g.agents.includes("*"));
  if (matching.length === 0) return undefined;
  return {
    agents: [token],
    allows: matching.flatMap((g) => g.allows),
    disallows: matching.flatMap((g) => g.disallows),
  };
}

export function isPathAllowed(
  groups: readonly RuleGroup[],
  userAgent: string,
  pathAndQuery: string,
): boolean {
  const rules = selectRules(groups, userAgent);
  if (!rules) return true;
  const path = pathAndQuery || "/";
  const disallowLen = longestMatch(rules.disallows, path);
  if (disallowLen < 0) return true;
  return longestMatch(rules.allows, path) >= disallowLen;
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

type RobotsVerdict = { status: "ok" | "deny_all" | "allow_all"; groups: RuleGroup[] };

async function fetchRobots(
  http: HttpClient,
  config: AppConfig,
  robotsUrl: string,
): Promise<{ verdict: RobotsVerdict; ttlSeconds: number }> {
  try {
    const res = await http.request({
      url: robotsUrl,
      timeoutMs: Math.min(config.httpTimeoutMs, 10_000),
      retries: 1,
      validateRedirects: true,
      maxBodyBytes: ROBOTS_MAX_BYTES,
      truncateBody: true,
      headers: { "User-Agent": config.userAgent },
    });
    if (res.status >= 500) {
      logger.warn("robots_5xx_deny", { url: safeUrlForLog(robotsUrl), status: res.status });
      return { verdict: { status: "deny_all", groups: [] }, ttlSeconds: config.robotsCacheTtlSeconds };
    }
    const verdict: RobotsVerdict =
      res.status >= 400
        ? { status: "allow_all", groups: [] }
        : { status: "ok", groups: parseRobotsTxt(res.body) };
    return { verdict, ttlSeconds: config.robotsCacheTtlSeconds };
  } catch (err) {
    logger.warn("robots_fetch_fail_deny", {
      url: safeUrlForLog(robotsUrl),
      error: err instanceof Error ? err.message : "fail",
    });
    return {
      verdict: { status: "deny_all", groups: [] },
      ttlSeconds: Math.min(ROBOTS_UNREACHABLE_TTL_SECONDS, config.robotsCacheTtlSeconds),
    };
  }
}

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
      let verdict = cache.get<RobotsVerdict>(cacheKey);
      if (!verdict) {
        const fetched = await fetchRobots(http, config, robotsUrl);
        verdict = fetched.verdict;
        cache.set(cacheKey, verdict, fetched.ttlSeconds);
      }

      if (verdict.status === "deny_all") return false;
      if (verdict.status === "allow_all") return true;
      return isPathAllowed(verdict.groups, userAgent, parsed.pathname + (parsed.search || ""));
    },
  };
}
