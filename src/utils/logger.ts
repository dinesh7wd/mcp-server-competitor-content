export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function write(level: LogLevel, message: string, extra?: Readonly<Record<string, unknown>>): void {
  if (RANK[level] < RANK[minLevel]) return;
  const payload =
    extra === undefined
      ? { ts: new Date().toISOString(), level, message }
      : { ts: new Date().toISOString(), level, message, ...extra };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

export const logger = {
  debug: (m: string, e?: Readonly<Record<string, unknown>>): void => write("debug", m, e),
  info: (m: string, e?: Readonly<Record<string, unknown>>): void => write("info", m, e),
  warn: (m: string, e?: Readonly<Record<string, unknown>>): void => write("warn", m, e),
  error: (m: string, e?: Readonly<Record<string, unknown>>): void => write("error", m, e),
};
