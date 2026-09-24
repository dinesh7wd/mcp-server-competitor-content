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

/** Deep-redact string values in log extras. */
export function redactExtra(
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === "string") {
      const key = k.toLowerCase();
      if (key.includes("url") || key.includes("href")) out[k] = safeUrlForLog(v);
      else out[k] = redactSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
