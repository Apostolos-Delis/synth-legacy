import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { loadTaskOutput, buildIterationMap } from "../engine/output-index.js";
import { writeText } from "../utils/fs.js";
import { withTmpDir } from "./helpers.js";

describe("loadTaskOutput", () => {
  test("returns empty string when no matching iterations", async () => {
    await withTmpDir(async (dir) => {
      const result = await loadTaskOutput(dir, "US-001", []);
      expect(result).toBe("");
    });
  });

  test("returns empty string when task has no matching entries", async () => {
    await withTmpDir(async (dir) => {
      const iterations = [{ taskId: "US-002", iteration: 1 }];
      const result = await loadTaskOutput(dir, "US-001", iterations);
      expect(result).toBe("");
    });
  });

  test("reads single log file for matching task", async () => {
    await withTmpDir(async (dir) => {
      const logContent = '{"type":"output","text":"hello"}\n';
      await writeText(join(dir, "iteration-001.jsonl"), logContent);

      const iterations = [{ taskId: "US-001", iteration: 1 }];
      const result = await loadTaskOutput(dir, "US-001", iterations);
      expect(result).toBe(logContent);
    });
  });

  test("concatenates multiple log files in iteration order", async () => {
    await withTmpDir(async (dir) => {
      await writeText(join(dir, "iteration-001.jsonl"), "line1\n");
      await writeText(join(dir, "iteration-003.jsonl"), "line3\n");

      const iterations = [
        { taskId: "US-001", iteration: 3 },
        { taskId: "US-001", iteration: 1 },
      ];
      const result = await loadTaskOutput(dir, "US-001", iterations);
      // Should be sorted by iteration number
      expect(result).toBe("line1\nline3\n");
    });
  });

  test("skips missing log files gracefully", async () => {
    await withTmpDir(async (dir) => {
      await writeText(join(dir, "iteration-001.jsonl"), "exists\n");
      // iteration-002.jsonl does not exist

      const iterations = [
        { taskId: "US-001", iteration: 1 },
        { taskId: "US-001", iteration: 2 },
      ];
      const result = await loadTaskOutput(dir, "US-001", iterations);
      expect(result).toBe("exists\n");
    });
  });

  test("filters by taskId correctly", async () => {
    await withTmpDir(async (dir) => {
      await writeText(join(dir, "iteration-001.jsonl"), "task1\n");
      await writeText(join(dir, "iteration-002.jsonl"), "task2\n");

      const iterations = [
        { taskId: "US-001", iteration: 1 },
        { taskId: "US-002", iteration: 2 },
      ];
      const result = await loadTaskOutput(dir, "US-001", iterations);
      expect(result).toBe("task1\n");
    });
  });

  test("handles empty log file content", async () => {
    await withTmpDir(async (dir) => {
      await writeText(join(dir, "iteration-001.jsonl"), "");

      const iterations = [{ taskId: "US-001", iteration: 1 }];
      const result = await loadTaskOutput(dir, "US-001", iterations);
      expect(result).toBe("");
    });
  });

  test("pads iteration number to 3 digits in filename", async () => {
    await withTmpDir(async (dir) => {
      // iteration 42 → iteration-042.jsonl
      await writeText(join(dir, "iteration-042.jsonl"), "padded\n");

      const iterations = [{ taskId: "US-001", iteration: 42 }];
      const result = await loadTaskOutput(dir, "US-001", iterations);
      expect(result).toBe("padded\n");
    });
  });
});

describe("buildIterationMap", () => {
  test("returns empty array when progress file does not exist", async () => {
    await withTmpDir(async (dir) => {
      const result = await buildIterationMap(join(dir, "nonexistent.md"));
      expect(result).toEqual([]);
    });
  });

  test("parses single iteration entry", async () => {
    await withTmpDir(async (dir) => {
      const progressPath = join(dir, "progress.md");
      await writeText(progressPath, "## Iteration 1 - US-001: First task\n- Status: done\n");
      const result = await buildIterationMap(progressPath);
      expect(result).toEqual([{ taskId: "US-001", iteration: 1 }]);
    });
  });

  test("parses multiple iteration entries", async () => {
    await withTmpDir(async (dir) => {
      const progressPath = join(dir, "progress.md");
      const content = [
        "## Iteration 1 - US-001: First task",
        "- Status: done",
        "---",
        "## Iteration 2 - US-002: Second task",
        "- Status: done",
        "---",
        "## Iteration 3 - US-001: First task retry",
        "- Status: done",
      ].join("\n");
      await writeText(progressPath, content);
      const result = await buildIterationMap(progressPath);
      expect(result).toEqual([
        { taskId: "US-001", iteration: 1 },
        { taskId: "US-002", iteration: 2 },
        { taskId: "US-001", iteration: 3 },
      ]);
    });
  });

  test("handles empty progress file", async () => {
    await withTmpDir(async (dir) => {
      const progressPath = join(dir, "progress.md");
      await writeText(progressPath, "");
      const result = await buildIterationMap(progressPath);
      expect(result).toEqual([]);
    });
  });

  test("ignores non-matching lines", async () => {
    await withTmpDir(async (dir) => {
      const progressPath = join(dir, "progress.md");
      const content = [
        "# Progress Report",
        "",
        "Some preamble text.",
        "",
        "## Iteration 5 - US-010: The real task",
        "- Status: in_progress",
      ].join("\n");
      await writeText(progressPath, content);
      const result = await buildIterationMap(progressPath);
      expect(result).toEqual([{ taskId: "US-010", iteration: 5 }]);
    });
  });

  test("trims whitespace from taskId", async () => {
    await withTmpDir(async (dir) => {
      const progressPath = join(dir, "progress.md");
      await writeText(progressPath, "## Iteration 1 -  US-001 : Task title\n");
      const result = await buildIterationMap(progressPath);
      expect(result[0].taskId).toBe("US-001");
    });
  });
});
