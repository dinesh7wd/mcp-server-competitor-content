/**
 * Redact secrets and query params from URLs/messages before logging or returning to clients.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/([?&](?:api_?key|key|token|access_token|auth|password|secret)=)[^&\s"']+/gi, "$1REDACTED")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1REDACTED")
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, "$1REDACTED");
}

/** Safe URL string for logs/errors — strips search params entirely. */
export function safeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return redactSecrets(raw).slice(0, 200);
  }
}

const MAX_REDACT_DEPTH = 5;

function redactValue(key: string, value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    const k = key.toLowerCase();
    return k.includes("url") || k.includes("href") ? safeUrlForLog(value) : redactSecrets(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACT_DEPTH) return "[redacted: too deep]";
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v, depth + 1));
  return redactExtra(value as Readonly<Record<string, unknown>>, depth + 1);
}

/** Recursively redact string values (objects and arrays) in log extras. */
export function redactExtra(
  extra: Readonly<Record<string, unknown>>,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    out[k] = redactValue(k, v, depth);
  }
  return out;
}
