import { describe, test, expect } from "bun:test";
import {
  parseTokenUsageLine,
  parseTokenUsageFromOutput,
  TokenAccumulator,
  formatTokenCount,
} from "../engine/tokens.js";

describe("parseTokenUsageLine", () => {
  test("parses Claude-style usage object", () => {
    const line = JSON.stringify({
      type: "result",
      usage: { input_tokens: 1500, output_tokens: 500 },
    });
    const result = parseTokenUsageLine(line);
    expect(result).toEqual({
      inputTokens: 1500,
      outputTokens: 500,
      totalTokens: 2000,
    });
  });

  test("parses Codex-style usage object", () => {
    const line = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 3000, output_tokens: 1200 },
    });
    const result = parseTokenUsageLine(line);
    expect(result).toEqual({
      inputTokens: 3000,
      outputTokens: 1200,
      totalTokens: 4200,
    });
  });

  test("parses camelCase token fields", () => {
    const line = JSON.stringify({
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    const result = parseTokenUsageLine(line);
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });

  test("returns null for non-JSON lines", () => {
    expect(parseTokenUsageLine("plain text output")).toBeNull();
    expect(parseTokenUsageLine("")).toBeNull();
    expect(parseTokenUsageLine("  ")).toBeNull();
  });

  test("returns null for JSON without usage data", () => {
    const line = JSON.stringify({ type: "assistant", message: "hello" });
    expect(parseTokenUsageLine(line)).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseTokenUsageLine("{invalid json")).toBeNull();
  });

  test("handles nested usage in data field", () => {
    const line = JSON.stringify({
      data: { usage: { prompt_tokens: 200, completion_tokens: 100 } },
    });
    const result = parseTokenUsageLine(line);
    expect(result).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
    });
  });
});

describe("parseTokenUsageFromOutput", () => {
  test("finds usage in multi-line output", () => {
    const output = [
      "Starting task...",
      "Processing files...",
      JSON.stringify({ usage: { input_tokens: 5000, output_tokens: 2000 } }),
      "Done.",
    ].join("\n");
    const result = parseTokenUsageFromOutput(output);
    expect(result).toEqual({
      inputTokens: 5000,
      outputTokens: 2000,
      totalTokens: 7000,
    });
  });

  test("returns null for output with no usage data", () => {
    const output = "Hello world\nThis is plain text\nNo JSON here";
    expect(parseTokenUsageFromOutput(output)).toBeNull();
  });

  test("returns null for empty output", () => {
    expect(parseTokenUsageFromOutput("")).toBeNull();
  });

  test("picks highest-signal usage when multiple present", () => {
    const output = [
      JSON.stringify({ usage: { total_tokens: 100 } }),
      JSON.stringify({ usage: { input_tokens: 5000, output_tokens: 2000 } }),
    ].join("\n");
    const result = parseTokenUsageFromOutput(output);
    expect(result!.inputTokens).toBe(5000);
    expect(result!.outputTokens).toBe(2000);
  });
});

describe("TokenAccumulator", () => {
  test("accumulates usage across tasks", () => {
    const acc = new TokenAccumulator();
    acc.add("TASK-001", { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    acc.add("TASK-002", { inputTokens: 200, outputTokens: 100, totalTokens: 300 });

    expect(acc.getSessionTotal()).toEqual({
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
    });
    expect(acc.getTaskTotal("TASK-001")).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    expect(acc.hasData()).toBe(true);
  });

  test("accumulates multiple iterations for same task", () => {
    const acc = new TokenAccumulator();
    acc.add("TASK-001", { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    acc.add("TASK-001", { inputTokens: 200, outputTokens: 100, totalTokens: 300 });

    expect(acc.getTaskTotal("TASK-001")).toEqual({
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
    });
  });

  test("ignores null usage", () => {
    const acc = new TokenAccumulator();
    acc.add("TASK-001", null);
    expect(acc.hasData()).toBe(false);
    expect(acc.getTaskTotal("TASK-001")).toBeNull();
  });

  test("returns null for unknown task", () => {
    const acc = new TokenAccumulator();
    expect(acc.getTaskTotal("UNKNOWN")).toBeNull();
  });
});

describe("parseTokenUsageFromOutput backwards scan edge cases", () => {
  const usageLine = JSON.stringify({ usage: { input_tokens: 100, output_tokens: 50 } });

  test("output with exactly 50 lines scans all of them", () => {
    const filler = Array.from({ length: 49 }, (_, i) => `line ${i + 1}`);
    const output = [...filler, usageLine].join("\n");
    const result = parseTokenUsageFromOutput(output);
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  test("output with fewer than 50 lines scans all", () => {
    const output = ["first line", "second line", usageLine].join("\n");
    const result = parseTokenUsageFromOutput(output);
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  test("output with no newlines (single long line)", () => {
    const result = parseTokenUsageFromOutput(usageLine);
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  test("empty output returns null", () => {
    expect(parseTokenUsageFromOutput("")).toBeNull();
  });

  test("usage line buried beyond 50-line window is not found", () => {
    const lines = [usageLine, ...Array.from({ length: 55 }, (_, i) => `filler ${i}`)];
    const output = lines.join("\n");
    const result = parseTokenUsageFromOutput(output);
    expect(result).toBeNull();
  });
});

describe("formatTokenCount", () => {
  test("formats small numbers as-is", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  test("formats thousands with k suffix", () => {
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(5000)).toBe("5k");
    expect(formatTokenCount(10000)).toBe("10k");
    expect(formatTokenCount(99999)).toBe("100k");
  });

  test("formats millions with m suffix", () => {
    expect(formatTokenCount(1_500_000)).toBe("1.5m");
    expect(formatTokenCount(2_000_000)).toBe("2m");
  });

  test("handles edge cases", () => {
    expect(formatTokenCount(-1)).toBe("0");
    expect(formatTokenCount(NaN)).toBe("0");
    expect(formatTokenCount(Infinity)).toBe("0");
  });
});
