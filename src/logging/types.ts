export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  msg: string;
  meta?: Record<string, unknown>;
}

export type LogSubscriber = (entry: LogEntry) => void;
