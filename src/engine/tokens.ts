/**
 * Token usage parsing and accumulation for agent output.
 * Scans raw agent output (stdout/stderr) for JSON lines containing
 * token usage data. Supports Claude, Codex, and generic provider formats.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const TOKEN_INPUT_KEYS = [
  "inputTokens",
  "input_tokens",
  "promptTokens",
  "prompt_tokens",
] as const;

const TOKEN_OUTPUT_KEYS = [
  "outputTokens",
  "output_tokens",
  "completionTokens",
  "completion_tokens",
] as const;

const TOKEN_TOTAL_KEYS = [
  "totalTokens",
  "total_tokens",
  "tokens",
] as const;

const USAGE_NESTED_KEYS = [
  "usage",
  "usage_stats",
  "cost",
  "stats",
  "metrics",
  "message",
  "result",
  "data",
] as const;

type JsonRecord = Record<string, unknown>;

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function readFirstNumber(record: JsonRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = readNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function extractFromRecord(record: JsonRecord): TokenUsage | null {
  const input = readFirstNumber(record, TOKEN_INPUT_KEYS);
  const output = readFirstNumber(record, TOKEN_OUTPUT_KEYS);
  const total = readFirstNumber(record, TOKEN_TOTAL_KEYS);

  if (input === undefined && output === undefined && total === undefined) {
    return null;
  }

  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    totalTokens: total ?? ((input ?? 0) + (output ?? 0)),
  };
}

function searchNested(obj: unknown, depth: number): TokenUsage | null {
  if (depth > 4 || typeof obj !== "object" || obj === null) return null;

  const record = obj as JsonRecord;

  const direct = extractFromRecord(record);
  if (direct) return direct;

  for (const key of USAGE_NESTED_KEYS) {
    const nested = record[key];
    if (nested && typeof nested === "object") {
      const found = searchNested(nested, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Parse a single line of output for token usage data.
 * Returns null if the line doesn't contain usage information.
 */
export function parseTokenUsageLine(line: string): TokenUsage | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;

  try {
    const parsed = JSON.parse(trimmed) as JsonRecord;
    return searchNested(parsed, 0);
  } catch {
    return null;
  }
}

/**
 * Scan raw agent output for token usage data.
 * Tries all lines and returns the best (highest-signal) match.
 */
export function parseTokenUsageFromOutput(output: string): TokenUsage | null {
  if (!output) return null;

  let best: TokenUsage | null = null;
  let bestScore = 0;

  // Token usage appears near the end of output — scan last 50 lines only.
  // Instead of splitting the entire string, scan backwards from the end
  // to find the 50th-from-last newline, then split only that tail substring.
  let tailStart = output.length;
  for (let remaining = 50; remaining > 0 && tailStart > 0; remaining--) {
    const prev = output.lastIndexOf("\n", tailStart - 1);
    tailStart = prev === -1 ? 0 : prev;
  }
  const tail = tailStart === 0 ? output : output.slice(tailStart + 1);
  const lines = tail.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const usage = parseTokenUsageLine(lines[i]);
    if (!usage) continue;
    const score =
      (usage.inputTokens > 0 ? 3 : 0) +
      (usage.outputTokens > 0 ? 3 : 0) +
      (usage.totalTokens > 0 ? 1 : 0);
    if (score > bestScore) {
      best = usage;
      bestScore = score;
    }
  }

  return best;
}

/**
 * Accumulates token usage across multiple iterations.
 */
export class TokenAccumulator {
  private sessionTotal: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private taskTotals = new Map<string, TokenUsage>();
  private _hasData = false;

  add(taskId: string, usage: TokenUsage | null): void {
    if (!usage) return;
    this._hasData = true;

    this.sessionTotal.inputTokens += usage.inputTokens;
    this.sessionTotal.outputTokens += usage.outputTokens;
    this.sessionTotal.totalTokens += usage.totalTokens;

    const existing = this.taskTotals.get(taskId) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    this.taskTotals.set(taskId, {
      inputTokens: existing.inputTokens + usage.inputTokens,
      outputTokens: existing.outputTokens + usage.outputTokens,
      totalTokens: existing.totalTokens + usage.totalTokens,
    });
  }

  getSessionTotal(): TokenUsage {
    return { ...this.sessionTotal };
  }

  getTaskTotal(taskId: string): TokenUsage | null {
    const total = this.taskTotals.get(taskId);
    return total ? { ...total } : null;
  }

  hasData(): boolean {
    return this._hasData;
  }
}

/**
 * Format a token count for compact display.
 * Examples: 950 -> "950", 1250 -> "1.3k", 1250000 -> "1.3m"
 */
export function formatTokenCount(tokens: number): string {
  const safe = Number.isFinite(tokens) && tokens >= 0 ? Math.floor(tokens) : 0;
  if (safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  }
  if (safe >= 10_000) {
    return `${Math.round(safe / 1_000)}k`;
  }
  if (safe >= 1_000) {
    return `${(safe / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(safe);
}
