import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogEntry, LogLevel, LogSubscriber } from "./types.js";

export class Logger {
  private readonly path: string;
  private readonly subscribers: LogSubscriber[] = [];
  private dirEnsured = false;

  constructor(path: string) {
    this.path = path;
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
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      msg,
      ...(meta !== undefined && { meta }),
    };

    for (const sub of this.subscribers) {
      sub(entry);
    }

    this.appendEntry(entry);
  }

  private appendEntry(entry: LogEntry): void {
    const line = JSON.stringify(entry) + "\n";
    const write = async () => {
      if (!this.dirEnsured) {
        await mkdir(dirname(this.path), { recursive: true });
        this.dirEnsured = true;
      }
      await appendFile(this.path, line);
    };
    write().catch((err: unknown) => {
      process.stderr.write(
        `[synth-logger] write error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
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

export function initLogger(path: string): Logger {
  singleton = new Logger(path);
  return singleton;
}

export function getLogger(): Logger {
  return singleton ?? noopLogger;
}
