import { ErrorCodes, McpError } from "./errors.js";

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;
  return false;
}

export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpError(ErrorCodes.InvalidParams, `Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpError(ErrorCodes.SsrfBlocked, "Only http(s) schemes allowed");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") {
    throw new McpError(ErrorCodes.SsrfBlocked, "Localhost blocked");
  }
  if (isPrivateIPv4(host) || host === "metadata.google.internal") {
    throw new McpError(ErrorCodes.SsrfBlocked, "Private/metadata IP blocked");
  }
  return url;
}
