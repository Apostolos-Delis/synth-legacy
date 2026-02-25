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
      const config = await loadConfig(dir, undefined, join(dir, "no-global.toml"));
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
      const config = await loadConfig(dir, undefined, join(dir, "no-global.toml"));
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

  test("global config merges over defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-test-"));
    const globalFile = join(dir, "global-config.toml");
    try {
      await writeText(globalFile, `[agent]\nmodel = "sonnet"\n\n[tui]\ntheme = "dracula"\n`);
      const config = await loadConfig(dir, undefined, globalFile);
      expect(config.agent.model).toBe("sonnet");
      expect(config.tui!.theme).toBe("dracula");
      // Defaults preserved for unset values
      expect(config.agent.name).toBe("claude");
      expect(config.execution.max_iterations).toBe(20);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("project config overrides global config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-test-"));
    const globalFile = join(dir, "global-config.toml");
    try {
      await writeText(globalFile, `[agent]\nmodel = "sonnet"\n\n[parallel]\nmax_workers = 4\n`);
      await writeText(join(dir, "synth.toml"), `[agent]\nmodel = "opus"\n`);
      const config = await loadConfig(dir, undefined, globalFile);
      expect(config.agent.model).toBe("opus");
      // Global value preserved when project doesn't override
      expect(config.parallel?.max_workers).toBe(4);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("full 3-layer merge: defaults → global → project → overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-test-"));
    const globalFile = join(dir, "global-config.toml");
    try {
      await writeText(globalFile, `[agent]\nmodel = "sonnet"\ntimeout = 300000\n\n[tui]\ntheme = "dracula"\n`);
      await writeText(join(dir, "synth.toml"), `[agent]\nmodel = "opus"\n\n[project]\nname = "test-proj"\n`);
      const config = await loadConfig(dir, { agent: { name: "codex", model: "opus", timeout: 600_000, skip_permissions: true } }, globalFile);
      // Override wins
      expect(config.agent.name).toBe("codex");
      // Project wins over global
      expect(config.agent.model).toBe("opus");
      // Global wins over default
      expect(config.tui!.theme).toBe("dracula");
      // Project-specific
      expect(config.project.name).toBe("test-proj");
      // Default preserved
      expect(config.execution.max_iterations).toBe(20);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("missing global config file behaves identically to before", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-test-"));
    const globalFile = join(dir, "nonexistent-global.toml");
    try {
      await writeText(join(dir, "synth.toml"), `[project]\nname = "test"\n`);
      const config = await loadConfig(dir, undefined, globalFile);
      expect(config.project.name).toBe("test");
      expect(config.agent.name).toBe("claude");
      expect(config.execution.max_iterations).toBe(20);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
