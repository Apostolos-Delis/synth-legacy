import { describe, test, expect } from "bun:test";
import { runBackpressure } from "../engine/backpressure.js";
import { withTmpDir } from "./helpers.js";

describe("runBackpressure", () => {
  test("empty commands list returns passed: true with no results", async () => {
    await withTmpDir(async (dir) => {
      const result = await runBackpressure([], dir);
      expect(result.passed).toBe(true);
      expect(result.results).toEqual([]);
    });
  });

  test("single passing command returns passed: true", async () => {
    await withTmpDir(async (dir) => {
      const result = await runBackpressure(["true"], dir);
      expect(result.passed).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].exitCode).toBe(0);
    });
  });

  test("single failing command returns passed: false", async () => {
    await withTmpDir(async (dir) => {
      const result = await runBackpressure(["false"], dir);
      expect(result.passed).toBe(false);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].exitCode).not.toBe(0);
    });
  });

  test("multiple commands all pass returns passed: true", async () => {
    await withTmpDir(async (dir) => {
      const result = await runBackpressure(["true", "true", "true"], dir);
      expect(result.passed).toBe(true);
      expect(result.results).toHaveLength(3);
      for (const r of result.results) {
        expect(r.exitCode).toBe(0);
      }
    });
  });

  test("multiple commands with one failure returns passed: false", async () => {
    await withTmpDir(async (dir) => {
      const result = await runBackpressure(["true", "false", "true"], dir);
      expect(result.passed).toBe(false);
      expect(result.results).toHaveLength(3);
      expect(result.results[0].exitCode).toBe(0);
      expect(result.results[1].exitCode).not.toBe(0);
      expect(result.results[2].exitCode).toBe(0);
    });
  });

  test("captures stdout in output", async () => {
    await withTmpDir(async (dir) => {
      const result = await runBackpressure(["echo hello"], dir);
      expect(result.passed).toBe(true);
      expect(result.results[0].output).toContain("hello");
    });
  });
});
