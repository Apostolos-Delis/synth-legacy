import { describe, test, expect, beforeEach, mock } from "bun:test";
import { WorktreeManager, sanitizeBranchName } from "./worktree-manager.js";

// Track all spawn calls for assertions
let spawnCalls: { cmd: string[]; cwd?: string }[] = [];
let spawnResults: Map<string, { exitCode: number; stdout: string; stderr: string }> = new Map();
let dirExistsResults: Map<string, boolean> = new Map();
let removedPaths: string[] = [];
let rmdirPaths: string[] = [];
let mockAvailableDiskMb = 10000;

function defaultSpawnResult() {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    timings: { spawnMs: 0, firstStdoutMs: null, firstStderrMs: null, totalMs: 0 },
  };
}

// Mock spawn
mock.module("../utils/process.js", () => ({
  spawn: (options: { cmd: string[]; cwd?: string }) => {
    spawnCalls.push({ cmd: options.cmd, cwd: options.cwd });
    const key = options.cmd.join(" ");

    // Check for specific result overrides
    for (const [pattern, result] of spawnResults) {
      if (key.includes(pattern)) {
        return {
          pid: 1,
          promise: Promise.resolve({ ...defaultSpawnResult(), ...result }),
          interrupt: () => {},
          process: {},
        };
      }
    }

    return {
      pid: 1,
      promise: Promise.resolve(defaultSpawnResult()),
      interrupt: () => {},
      process: {},
    };
  },
}));

// Mock fs utilities
mock.module("../utils/fs.js", () => ({
  dirExists: async (path: string) => dirExistsResults.get(path) ?? false,
}));

// Mock platform
mock.module("../platform/index.js", () => ({
  getPlatform: () => ({
    getAvailableDiskMb: async () => mockAvailableDiskMb,
  }),
}));

// Mock node:fs/promises
mock.module("node:fs/promises", () => ({
  rm: async (path: string) => {
    removedPaths.push(path);
  },
  rmdir: async (path: string) => {
    rmdirPaths.push(path);
  },
}));

function makeManager(opts?: { maxWorktrees?: number }) {
  return new WorktreeManager({
    repoRoot: "/repo",
    project: "my-project",
    maxWorktrees: opts?.maxWorktrees,
  });
}

function setDfOutput(availableMb: number) {
  mockAvailableDiskMb = availableMb;
}

beforeEach(() => {
  spawnCalls = [];
  spawnResults = new Map();
  dirExistsResults = new Map();
  removedPaths = [];
  rmdirPaths = [];
  mockAvailableDiskMb = 10000; // plenty of space by default
});

describe("sanitizeBranchName", () => {
  test("replaces special characters with hyphens", () => {
    expect(sanitizeBranchName("feat/foo@bar")).toBe("feat-foo-bar");
  });

  test("collapses multiple hyphens", () => {
    expect(sanitizeBranchName("a---b")).toBe("a-b");
  });

  test("strips leading and trailing hyphens", () => {
    expect(sanitizeBranchName("--hello--")).toBe("hello");
  });

  test("preserves alphanumeric and hyphens", () => {
    expect(sanitizeBranchName("COOR-005")).toBe("COOR-005");
  });

  test("handles dots and slashes", () => {
    expect(sanitizeBranchName("v1.2/feature")).toBe("v1-2-feature");
  });
});

describe("WorktreeManager", () => {
  describe("acquire", () => {
    test("creates git worktree at correct path with correct branch", async () => {
      const mgr = makeManager();
      const info = await mgr.acquire("w1", "COOR-005", "main");

      expect(info.path).toBe("/.synth-worktrees/my-project/worker-w1");
      expect(info.branch).toBe("synth-parallel/COOR-005");
      expect(info.workerId).toBe("w1");
      expect(info.taskId).toBe("COOR-005");

      // Verify git worktree add was called
      const addCall = spawnCalls.find((c) => c.cmd.includes("worktree") && c.cmd.includes("add"));
      expect(addCall).toBeDefined();
      expect(addCall!.cmd).toEqual([
        "git", "worktree", "add", "-b",
        "synth-parallel/COOR-005",
        "/.synth-worktrees/my-project/worker-w1",
        "main",
      ]);
      expect(addCall!.cwd).toBe("/repo");
    });

    test("sanitizes branch name for special chars in taskId", async () => {
      const mgr = makeManager();
      const info = await mgr.acquire("w1", "feat/foo@bar", "main");

      expect(info.branch).toBe("synth-parallel/feat-foo-bar");
    });

    test("cleans up stale worktree at target path before creation", async () => {
      const targetPath = "/.synth-worktrees/my-project/worker-w1";
      dirExistsResults.set(targetPath, true);

      const mgr = makeManager();
      await mgr.acquire("w1", "COOR-005", "main");

      // Should have called git worktree remove before add
      const removeIdx = spawnCalls.findIndex(
        (c) => c.cmd.includes("worktree") && c.cmd.includes("remove"),
      );
      const addIdx = spawnCalls.findIndex(
        (c) => c.cmd.includes("worktree") && c.cmd.includes("add"),
      );
      expect(removeIdx).toBeGreaterThanOrEqual(0);
      expect(addIdx).toBeGreaterThan(removeIdx);
    });
  });

  describe("max capacity", () => {
    test("throws 'Maximum worktrees reached' at capacity", async () => {
      const mgr = makeManager({ maxWorktrees: 2 });
      await mgr.acquire("w1", "T-001", "main");
      await mgr.acquire("w2", "T-002", "main");

      await expect(mgr.acquire("w3", "T-003", "main")).rejects.toThrow(
        "Maximum worktrees reached",
      );
    });

    test("allows acquisition after release frees a slot", async () => {
      const mgr = makeManager({ maxWorktrees: 1 });
      await mgr.acquire("w1", "T-001", "main");
      await mgr.release("w1");

      // Should not throw
      const info = await mgr.acquire("w2", "T-002", "main");
      expect(info.workerId).toBe("w2");
    });
  });

  describe("disk space", () => {
    test("prevents acquisition when <500MB free", async () => {
      setDfOutput(400);
      const mgr = makeManager();

      await expect(mgr.acquire("w1", "T-001", "main")).rejects.toThrow(
        "Insufficient disk space",
      );
    });

    test("allows acquisition when >=500MB free", async () => {
      setDfOutput(500);
      const mgr = makeManager();

      const info = await mgr.acquire("w1", "T-001", "main");
      expect(info.workerId).toBe("w1");
    });
  });

  describe("release", () => {
    test("removes worktree and deletes branch", async () => {
      const mgr = makeManager();
      await mgr.acquire("w1", "COOR-005", "main");
      spawnCalls = []; // reset to only track release calls

      await mgr.release("w1");

      const removeCall = spawnCalls.find(
        (c) => c.cmd.includes("worktree") && c.cmd.includes("remove"),
      );
      expect(removeCall).toBeDefined();

      const branchDelete = spawnCalls.find(
        (c) => c.cmd.includes("branch") && c.cmd.includes("-D"),
      );
      expect(branchDelete).toBeDefined();
      expect(branchDelete!.cmd).toContain("synth-parallel/COOR-005");

      expect(mgr.getActive().size).toBe(0);
    });

    test("no-op for unknown workerId", async () => {
      const mgr = makeManager();
      spawnCalls = [];
      await mgr.release("unknown");
      // Should not spawn any commands
      expect(spawnCalls).toEqual([]);
    });
  });

  describe("cleanupAll", () => {
    test("removes all worktrees, branches, and attempts rmdir on base", async () => {
      const mgr = makeManager();
      await mgr.acquire("w1", "T-001", "main");
      await mgr.acquire("w2", "T-002", "main");
      spawnCalls = [];

      const basePath = "/.synth-worktrees/my-project";
      dirExistsResults.set(basePath, true);

      await mgr.cleanupAll();

      // Should have removed 2 worktrees
      const removeCalls = spawnCalls.filter(
        (c) => c.cmd.includes("worktree") && c.cmd.includes("remove"),
      );
      expect(removeCalls.length).toBe(2);

      // Should have deleted 2 branches
      const branchDeletes = spawnCalls.filter(
        (c) => c.cmd.includes("branch") && c.cmd.includes("-D"),
      );
      expect(branchDeletes.length).toBe(2);

      // Should attempt rmdir on base directory
      expect(rmdirPaths).toContain(basePath);

      expect(mgr.getActive().size).toBe(0);
    });
  });

  describe("cleanupOrphanedWorktrees", () => {
    test("removes worktrees under managed path that are not active", async () => {
      const mgr = makeManager();
      spawnResults.set("worktree list", {
        exitCode: 0,
        stdout: [
          "worktree /repo",
          "HEAD abc123",
          "branch refs/heads/main",
          "",
          "worktree /.synth-worktrees/my-project/worker-orphan",
          "HEAD def456",
          "branch refs/heads/synth-parallel/OLD-TASK",
          "",
        ].join("\n"),
        stderr: "",
      });

      await mgr.cleanupOrphanedWorktrees();

      const removeCall = spawnCalls.find(
        (c) =>
          c.cmd.includes("worktree") &&
          c.cmd.includes("remove") &&
          c.cmd.some((arg) => arg.includes("worker-orphan")),
      );
      expect(removeCall).toBeDefined();
    });

    test("does not remove worktrees outside managed path", async () => {
      const mgr = makeManager();
      spawnResults.set("worktree list", {
        exitCode: 0,
        stdout: [
          "worktree /other-location/worker-x",
          "HEAD abc123",
          "branch refs/heads/some-branch",
          "",
        ].join("\n"),
        stderr: "",
      });

      spawnCalls = [];
      await mgr.cleanupOrphanedWorktrees();

      const removeCall = spawnCalls.find(
        (c) => c.cmd.includes("worktree") && c.cmd.includes("remove"),
      );
      expect(removeCall).toBeUndefined();
    });
  });
});
