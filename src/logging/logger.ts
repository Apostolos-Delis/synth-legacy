import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogEntry, LogError, LogLevel, LogSubscriber } from "./types.js";

const DEFAULT_SERVICE = process.env.SYNTH_SERVICE ?? process.env.SERVICE_NAME ?? "synth";
const DEFAULT_ENV = process.env.SYNTH_ENV ?? process.env.NODE_ENV ?? "development";
const MAX_META_CHARS = 10_000;
const MAX_CONTEXT_CHARS = 2_000;
const MAX_LOG_BYTES = 10_000_000;
const LOG_ROTATION_COUNT = 3;
const LOG_SIZE_CHECK_EVERY = 200;

interface LoggerOptions {
  service?: string;
  env?: string;
  context?: Record<string, unknown>;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "function") {
        return val.name ? `[Function: ${val.name}]` : "[Function]";
      }
      if (typeof val === "symbol") return val.toString();
      if (val instanceof Date) return val.toISOString();
      if (val instanceof Error) {
        const err: LogError = {
          type: val.name || val.constructor?.name || "Error",
          message: val.message || "Unknown error",
        };
        if (val.stack) err.stack = val.stack;
        return err;
      }
      if (val && typeof val === "object") {
        if (seen.has(val as object)) return "[Circular]";
        seen.add(val as object);
      }
      return val;
    });
    return json ?? "";
  } catch {
    try {
      return JSON.stringify({ value: String(value) }) ?? "";
    } catch {
      return "";
    }
  }
}

function normalizeContextFields(input: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case "request_id":
      case "requestId":
      case "requestID":
        normalized.request_id = value;
        break;
      case "job_id":
      case "jobId":
      case "jobID":
        normalized.job_id = value;
        break;
      case "duration_ms":
      case "durationMs":
      case "durationMS":
      case "duration":
        normalized.duration_ms = value;
        break;
      default:
        normalized[key] = value;
    }
  }
  return normalized;
}

function extractContext(
  meta?: Record<string, unknown>,
): { context?: Record<string, unknown>; meta?: Record<string, unknown> } {
  if (!meta) return {};
  const context: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    switch (key) {
      case "request_id":
      case "requestId":
      case "requestID":
        context.request_id = value;
        break;
      case "job_id":
      case "jobId":
      case "jobID":
        context.job_id = value;
        break;
      case "duration_ms":
      case "durationMs":
      case "durationMS":
      case "duration":
        context.duration_ms = value;
        break;
      default:
        rest[key] = value;
    }
  }

  return {
    context: Object.keys(context).length > 0 ? context : undefined,
    meta: Object.keys(rest).length > 0 ? rest : undefined,
  };
}

function mergeContext(
  base?: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!base && !extra) return undefined;
  return { ...(base ?? {}), ...(extra ?? {}) };
}

function buildErrorObject(value: unknown, fallbackMessage: string): LogError {
  if (value instanceof Error) {
    const err: LogError = {
      type: value.name || value.constructor?.name || "Error",
      message: value.message || fallbackMessage || "Unknown error",
    };
    if (value.stack) err.stack = value.stack;
    return err;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const type = typeof record.type === "string"
      ? record.type
      : typeof record.name === "string"
        ? record.name
        : "Error";
    const message = typeof record.message === "string"
      ? record.message
      : fallbackMessage || "Unknown error";
    const err: LogError = { type, message };
    if (typeof record.stack === "string") err.stack = record.stack;
    return err;
  }
  if (typeof value === "string") {
    return { type: "Error", message: value || fallbackMessage || "Unknown error" };
  }
  return { type: "Error", message: fallbackMessage || "Unknown error" };
}

function extractError(
  level: LogLevel,
  meta: Record<string, unknown> | undefined,
  message: string,
): { error?: LogError; meta?: Record<string, unknown> } {
  let errorValue: unknown;
  let restMeta = meta;
  if (meta && Object.prototype.hasOwnProperty.call(meta, "error")) {
    const { error, ...rest } = meta;
    errorValue = error;
    restMeta = Object.keys(rest).length > 0 ? rest : undefined;
  }

  if (level === "error" || errorValue !== undefined) {
    return { error: buildErrorObject(errorValue, message), meta: restMeta };
  }

  return { meta: restMeta };
}

function normalizeObject(value: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  const json = safeStringify(value);
  if (!json) return {};
  if (json.length <= maxChars) {
    try {
      return structuredClone(value);
    } catch {
      // Fallback for non-cloneable values (functions, symbols, etc.)
      try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; }
    }
  }
  return { truncated: true, size: json.length, preview: json.slice(0, maxChars) };
}

function normalizeService(value?: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_SERVICE;
}

function normalizeEnv(value?: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_ENV;
}

export class Logger {
  private readonly path: string;
  private readonly subscribers: LogSubscriber[] = [];
  private dirEnsured = false;
  private writeChain: Promise<void> = Promise.resolve();
  private writeCount = 0;
  private readonly service: string;
  private readonly env: string;
  private readonly baseContext?: Record<string, unknown>;

  constructor(path: string, options: LoggerOptions = {}) {
    this.path = path;
    this.service = normalizeService(options.service);
    this.env = normalizeEnv(options.env);
    this.baseContext = options.context
      ? normalizeContextFields(options.context)
      : undefined;
  }

  debug(event: string, msg: string, meta?: Record<string, unknown>): void {
    this.emit("debug", event, msg, meta);
  }

  info(event: string, msg: string, meta?: Record<string, unknown>): void {
    this.emit("info", event, msg, meta);
  }

  warn(event: string, msg: string, meta?: Record<string, unknown>): void {
    this.emit("warn", event, msg, meta);
  }

  error(event: string, msg: string, meta?: Record<string, unknown>): void {
    this.emit("error", event, msg, meta);
  }

  subscribe(cb: LogSubscriber): () => void {
    this.subscribers.push(cb);
    return () => {
      const idx = this.subscribers.indexOf(cb);
      if (idx !== -1) this.subscribers.splice(idx, 1);
    };
  }

  private emit(
    level: LogLevel,
    event: string,
    msg: string,
    meta?: Record<string, unknown>,
  ): void {
    const { context: extractedContext, meta: restMeta } = extractContext(meta);
    const mergedContext = mergeContext(this.baseContext, extractedContext);
    const { error, meta: cleanedMeta } = extractError(level, restMeta, msg);

    const context = mergedContext
      ? normalizeObject(mergedContext, MAX_CONTEXT_CHARS)
      : undefined;
    const normalizedMeta = cleanedMeta
      ? normalizeObject(cleanedMeta, MAX_META_CHARS)
      : undefined;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      message: msg,
      service: this.service,
      env: this.env,
      ...(context && { context }),
      ...(normalizedMeta && { meta: normalizedMeta }),
      ...(error && { error }),
    };

    for (const sub of this.subscribers) {
      sub(entry);
    }

    this.appendEntry(entry);
  }

  private appendEntry(entry: LogEntry): void {
    const line = safeStringify(entry) + "\n";
    const write = async () => {
      if (!this.dirEnsured) {
        await mkdir(dirname(this.path), { recursive: true });
        this.dirEnsured = true;
      }
      this.writeCount += 1;
      await this.rotateIfNeeded();
      await appendFile(this.path, line);
    };
    this.writeChain = this.writeChain
      .then(write)
      .catch(async (err: unknown) => {
        if (!this.dirEnsured) {
          try {
            await mkdir(dirname(this.path), { recursive: true });
            this.dirEnsured = true;
            await appendFile(this.path, line);
            return;
          } catch {
          }
        }
        this.writeFallback(err);
      });
  }

  private async rotateIfNeeded(): Promise<void> {
    if (this.writeCount % LOG_SIZE_CHECK_EVERY !== 0) return;
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return;
    }
    if (size < MAX_LOG_BYTES) return;
    for (let i = LOG_ROTATION_COUNT; i >= 1; i -= 1) {
      const src = i === 1 ? this.path : `${this.path}.${i - 1}`;
      const dest = `${this.path}.${i}`;
      try {
        await rename(src, dest);
      } catch {
      }
    }
    try {
      await unlink(`${this.path}.${LOG_ROTATION_COUNT + 1}`);
    } catch {
    }
  }

  private writeFallback(err: unknown): void {
    const fallback: LogEntry = {
      timestamp: new Date().toISOString(),
      level: "error",
      event: "logger:write-failure",
      message: "Log write failed",
      service: this.service,
      env: this.env,
      error: buildErrorObject(err, "Log write failed"),
    };
    const line = safeStringify(fallback);
    if (!line) return;
    try {
      process.stderr.write(line + "\n");
    } catch {
    }
  }
}

const noopLogger: Logger = new Proxy({} as Logger, {
  get(_target, prop) {
    if (
      prop === "debug" ||
      prop === "info" ||
      prop === "warn" ||
      prop === "error"
    ) {
      return () => {};
    }
    if (prop === "subscribe") {
      return () => () => {};
    }
    return undefined;
  },
});

let singleton: Logger | undefined;

export function initLogger(path: string, options?: LoggerOptions): Logger {
  singleton = new Logger(path, options);
  return singleton;
}

export function getLogger(): Logger {
  return singleton ?? noopLogger;
}
