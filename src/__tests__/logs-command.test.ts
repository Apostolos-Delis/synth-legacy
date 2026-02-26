import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { readLogFile, isSessionComplete } from "../logging/reader.js";
import { withTmpDir } from "./helpers.js";
import type { LogEntry } from "../logging/types.js";

const sampleEntries: LogEntry[] = [
  {
    timestamp: "2026-01-15T10:00:00.000Z",
    level: "info",
    event: "session:start",
    message: "Session started",
    service: "synth",
    env: "test",
  },
  {
    timestamp: "2026-01-15T10:00:01.000Z",
    level: "debug",
    event: "task:begin",
    message: "Starting task US-001",
    service: "synth",
    env: "test",
  },
  {
    timestamp: "2026-01-15T10:00:02.000Z",
    level: "warn",
    event: "rate:limit",
    message: "Approaching rate limit",
    service: "synth",
    env: "test",
    meta: { remaining: 5 },
  },
  {
    timestamp: "2026-01-15T10:00:03.000Z",
    level: "error",
    event: "task:fail",
    message: "Task failed",
    service: "synth",
    env: "test",
    meta: { error: "timeout" },
    error: { type: "Error", message: "timeout" },
  },
  {
    timestamp: "2026-01-15T10:00:04.000Z",
    level: "info",
    event: "state:change",
    message: "completed",
    service: "synth",
    env: "test",
  },
];

function entriesToJsonl(entries: LogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("logs command — readLogFile", () => {
  test("reads known JSONL entries and produces matching output", async () => {
    await withTmpDir(async (dir) => {
      const logPath = join(dir, "session.log");
      await writeFile(logPath, entriesToJsonl(sampleEntries));

      const results: LogEntry[] = [];
      for await (const entry of readLogFile(logPath)) {
        results.push(entry);
      }

      expect(results).toHaveLength(sampleEntries.length);
      for (let i = 0; i < sampleEntries.length; i++) {
        expect(results[i].timestamp).toBe(sampleEntries[i].timestamp);
        expect(results[i].level).toBe(sampleEntries[i].level);
        expect(results[i].event).toBe(sampleEntries[i].event);
        expect(results[i].message).toBe(sampleEntries[i].message);
        if (sampleEntries[i].meta) {
          expect(results[i].meta).toEqual(sampleEntries[i].meta);
        }
      }
    });
  });

  test("handles file without trailing newline", async () => {
    await withTmpDir(async (dir) => {
      const logPath = join(dir, "session.log");
      const content = sampleEntries.map((e) => JSON.stringify(e)).join("\n"); // no trailing newline
      await writeFile(logPath, content);

      const results: LogEntry[] = [];
      for await (const entry of readLogFile(logPath)) {
        results.push(entry);
      }

      expect(results).toHaveLength(sampleEntries.length);
      expect(results[0].event).toBe("session:start");
      expect(results[4].event).toBe("state:change");
    });
  });
});

describe("logs command — missing log file", () => {
  test("readLogFile throws for nonexistent file", async () => {
    await withTmpDir(async (dir) => {
      const logPath = join(dir, "nonexistent.log");

      let threw = false;
      try {
        // Must consume the generator to trigger the file open
        for await (const _entry of readLogFile(logPath)) {
          // should not reach here
        }
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);
    });
  });

  test("isSessionComplete returns false for nonexistent file", async () => {
    await withTmpDir(async (dir) => {
      const logPath = join(dir, "nonexistent.log");
      const result = await isSessionComplete(logPath);
      expect(result).toBe(false);
    });
  });
});

describe("logs command — corrupt lines", () => {
  test("skips corrupt lines and yields valid entries", async () => {
    await withTmpDir(async (dir) => {
      const logPath = join(dir, "session.log");
      const lines = [
        JSON.stringify(sampleEntries[0]),
        "this is not json at all",
        "{broken json: ???",
        JSON.stringify(sampleEntries[1]),
        "",
        JSON.stringify(sampleEntries[2]),
      ];
      await writeFile(logPath, lines.join("\n") + "\n");

      const results: LogEntry[] = [];
      for await (const entry of readLogFile(logPath)) {
        results.push(entry);
      }

      expect(results).toHaveLength(3);
      expect(results[0].event).toBe("session:start");
      expect(results[1].event).toBe("task:begin");
      expect(results[2].event).toBe("rate:limit");
    });
  });

  test("handles file that is entirely corrupt", async () => {
    await withTmpDir(async (dir) => {
      const logPath = join(dir, "session.log");
      await writeFile(logPath, "not json\nalso not json\n{bad\n");

      const results: LogEntry[] = [];
      for await (const entry of readLogFile(logPath)) {
        results.push(entry);
      }

      expect(results).toHaveLength(0);
    });
  });

  test("handles empty file", async () => {
    await withTmpDir(async (dir) => {
      const logPath = join(dir, "session.log");
      await writeFile(logPath, "");

      const results: LogEntry[] = [];
      for await (const entry of readLogFile(logPath)) {
        results.push(entry);
      }

      expect(results).toHaveLength(0);
    });
  });
});

describe("logs command — session resolution", () => {
  test("isSessionComplete returns true when last entry is state:change completed", async () => {
    await withTmpDir(async (dir) => {
      const logPath = join(dir, "session.log");
      await writeFile(logPath, entriesToJsonl(sampleEntries));

      const result = await isSessionComplete(logPath);
      expect(result).toBe(true);
    });
  });

  test("isSessionComplete returns false when no completion entry exists", async () => {
    await withTmpDir(async (dir) => {
      const logPath = join(dir, "session.log");
      const incomplete = sampleEntries.slice(0, 3); // no state:change completed
      await writeFile(logPath, entriesToJsonl(incomplete));

      const result = await isSessionComplete(logPath);
      expect(result).toBe(false);
    });
  });

  test("isSessionComplete returns false for empty file", async () => {
    await withTmpDir(async (dir) => {
      const logPath = join(dir, "session.log");
      await writeFile(logPath, "");

      const result = await isSessionComplete(logPath);
      expect(result).toBe(false);
    });
  });
});
