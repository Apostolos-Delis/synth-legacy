export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogError {
  type: string;
  message: string;
  stack?: string;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event?: string;
  message: string;
  service: string;
  env: string;
  context?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  error?: LogError;
}

export type LogSubscriber = (entry: LogEntry) => void;