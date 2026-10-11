// Structured JSON logs, one object per line. Railway parses `message` and `level` and turns every
// other field into a filterable attribute (e.g. `@repo:acme/api`). Never log code, diffs or prompts.
type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const rank: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = (process.env.LOG_LEVEL as Level | undefined) ?? "info";

function serialize(_key: string, value: unknown) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === "bigint") return value.toString();
  return value;
}

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

function createLogger(base: Fields): Logger {
  const write = (level: Level, message: string, fields?: Fields) => {
    if (rank[level] < rank[minLevel]) return;
    console.log(JSON.stringify({ level, message, ...base, ...fields }, serialize));
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

export const log = createLogger({ role: process.env.ROLE ?? process.env.RAILWAY_SERVICE_NAME });
