import { describe, test, expect } from "bun:test";
import { loadConfig } from "../config/loader.js";
import { writeText } from "../utils/fs.js";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("loadConfig", () => {
  test("returns defaults when no synth.toml exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-test-"));
    try {
      const config = await loadConfig(dir);
      expect(config.agent.name).toBe("claude");
      expect(config.execution.max_iterations).toBe(20);
      expect(config.guardrails.max_consecutive_failures).toBe(3);
      expect(config.project.base_branch).toBe("main");
      expect(config.agent.skip_permissions).toBe(true);
      expect(config.notifications?.enabled).toBe(true);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("merges TOML overrides over defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-test-"));
    try {
      await writeText(
        join(dir, "synth.toml"),
        `[project]\nname = "custom"\nbranch = "feat/x"\n\n[execution]\nmax_iterations = 5\n`,
      );
      const config = await loadConfig(dir);
      expect(config.project.name).toBe("custom");
      expect(config.project.branch).toBe("feat/x");
      expect(config.execution.max_iterations).toBe(5);
      // Defaults preserved for unset values
      expect(config.agent.name).toBe("claude");
      expect(config.execution.auto_commit).toBe(true);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("applies programmatic overrides last", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-test-"));
    try {
      await writeText(join(dir, "synth.toml"), `[execution]\nmax_iterations = 5\n`);
      const config = await loadConfig(dir, {
        execution: { max_iterations: 99, iteration_delay: 2000, auto_commit: true },
      });
      expect(config.execution.max_iterations).toBe(99);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("auto-detects project name from directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-test-"));
    try {
      const config = await loadConfig(dir);
      expect(config.project.name).toBeTruthy();
      expect(config.project.name.startsWith("synth-test-")).toBe(true);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("parallel section uses defaults when missing from toml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-test-"));
    try {
      const config = await loadConfig(dir);
      expect(config.parallel?.enabled).toBe(true);
      expect(config.parallel?.max_workers).toBe(8);
      expect(config.parallel?.ai_conflict_resolution).toBe(true);
      expect(config.parallel?.max_requeue_count).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("parallel section merges from toml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-test-"));
    try {
      await writeText(
        join(dir, "synth.toml"),
        `[parallel]\nmax_workers = 4\nai_conflict_resolution = false\n`,
      );
      const config = await loadConfig(dir);
      expect(config.parallel?.max_workers).toBe(4);
      expect(config.parallel?.ai_conflict_resolution).toBe(false);
      // Defaults preserved for unset fields
      expect(config.parallel?.enabled).toBe(true);
      expect(config.parallel?.max_requeue_count).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("parallel.enabled can be disabled via toml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-test-"));
    try {
      await writeText(join(dir, "synth.toml"), `[parallel]\nenabled = false\n`);
      const config = await loadConfig(dir);
      expect(config.parallel?.enabled).toBe(false);
      // Other defaults preserved
      expect(config.parallel?.max_workers).toBe(8);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("array values replace rather than merge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-test-"));
    try {
      await writeText(
        join(dir, "synth.toml"),
        `[guardrails]\nbackpressure_commands = ["bun test"]\n`,
      );
      const config = await loadConfig(dir);
      expect(config.guardrails.backpressure_commands).toEqual(["bun test"]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
