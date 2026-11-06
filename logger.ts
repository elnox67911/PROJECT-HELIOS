const REDACTED = "[redacted]";
const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|credential|authorization)/i;

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogFields {
  [key: string]: unknown;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(k) && typeof v === "string" && v.length > 0) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly level: LogLevel = (process.env.HELIOS_LOG_LEVEL as LogLevel) ?? "info",
    private readonly pretty: boolean = process.env.HELIOS_LOG_PRETTY !== "0",
    private readonly sink: (line: string) => void = (line) => process.stdout.write(line + "\n"),
  ) {}

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.level, this.pretty, this.sink);
  }

  debug(msg: string, fields?: LogFields): void {
    this.write("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.write("error", msg, fields);
  }

  write(level: LogLevel, msg: string, fields?: LogFields): void {
    const record = {
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      msg,
      ...(fields ? (redact(fields) as LogFields) : {}),
    };
    this.sink(this.pretty ? prettify(record) : JSON.stringify(record));
  }
}

function prettify(record: Record<string, unknown>): string {
  const { ts, level, scope, msg, ...rest } = record;
  const time = String(ts).slice(11, 23);
  const extra = Object.keys(rest).length ? " " + JSON.stringify(rest) : "";
  return `${time} ${String(level).toUpperCase().padEnd(5)} [${scope}] ${msg}${extra}`;
}

export const rootLogger = new Logger("helios");

/** Removes secret-bearing environment variables before spawning child processes. */
export function sanitizeEnv(
  env: NodeJS.ProcessEnv,
  opts: { enabled: boolean; allowVars: string[] },
): NodeJS.ProcessEnv {
  if (!opts.enabled) return { ...env };
  const allowed = new Set([
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "PWD",
    "TERM",
    "NODE_ENV",
    ...opts.allowVars,
  ]);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (allowed.has(key)) {
      out[key] = value;
      continue;
    }
    if (SECRET_KEY_PATTERN.test(key)) continue;
    if (/^HELIOS_/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}
