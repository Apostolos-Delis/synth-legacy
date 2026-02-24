import { describe, test, expect, beforeEach, mock } from "bun:test";
import { MergeEngine } from "./merge-engine.js";

// Track all spawn calls for assertions
let spawnCalls: { cmd: string[]; cwd?: string }[] = [];
let spawnResults: Map<
  string,
  { exitCode: number; stdout: string; stderr: string }
> = new Map();

function defaultSpawnResult() {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    timings: {
      spawnMs: 0,
      firstStdoutMs: null,
      firstStderrMs: null,
      totalMs: 0,
    },
  };
}

// Mock spawn — patterns are matched in insertion order against cmd.join(" ")
mock.module("../utils/process.js", () => ({
  spawn: (options: { cmd: string[]; cwd?: string }) => {
    spawnCalls.push({ cmd: options.cmd, cwd: options.cwd });
    const key = options.cmd.join(" ");

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

function makeEngine() {
  return new MergeEngine({ repoRoot: "/repo" });
}

function setLogHasCommits() {
  spawnResults.set("git log", {
    exitCode: 0,
    stdout: "abc1234 some commit\n",
    stderr: "",
  });
}

beforeEach(() => {
  spawnCalls = [];
  spawnResults = new Map();
});

describe("MergeEngine", () => {
  describe("initializeSessionBranch", () => {
    test("creates synth-session branch from first 8 chars of sessionId", async () => {
      const engine = makeEngine();
      const branch = await engine.initializeSessionBranch(
        "abc12345-full-session-uuid",
      );

      expect(branch).toBe("synth-session/abc12345");
      expect(engine.getSessionBranch()).toBe("synth-session/abc12345");

      const checkoutCall = spawnCalls.find((c) =>
        c.cmd.includes("checkout"),
      );
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall!.cmd).toEqual([
        "git",
        "checkout",
        "-b",
        "synth-session/abc12345",
      ]);
      expect(checkoutCall!.cwd).toBe("/repo");
    });

    test("throws on git checkout failure", async () => {
      spawnResults.set("checkout", {
        exitCode: 1,
        stdout: "",
        stderr: "fatal: branch already exists",
      });

      const engine = makeEngine();
      await expect(
        engine.initializeSessionBranch("abc12345"),
      ).rejects.toThrow("Failed to create session branch");
    });

    test("does not set sessionBranch on failure", async () => {
      spawnResults.set("checkout", {
        exitCode: 1,
        stdout: "",
        stderr: "error",
      });

      const engine = makeEngine();
      try {
        await engine.initializeSessionBranch("abc12345");
      } catch {
        // expected
      }
      expect(engine.getSessionBranch()).toBeNull();
    });
  });

  describe("enqueue", () => {
    test("creates MergeOperation with queued status", () => {
      const engine = makeEngine();
      const op = engine.enqueue({
        workerId: "w1",
        taskId: "COOR-001",
        taskTitle: "Add affects field",
        branch: "synth-parallel/COOR-001",
      });

      expect(op.status).toBe("queued");
      expect(op.taskId).toBe("COOR-001");
      expect(op.taskTitle).toBe("Add affects field");
      expect(op.sourceBranch).toBe("synth-parallel/COOR-001");
      expect(op.id).toMatch(/^merge-/);
    });

    test("assigns unique IDs to each operation", () => {
      const engine = makeEngine();
      const op1 = engine.enqueue({
        workerId: "w1",
        taskId: "T-001",
        taskTitle: "Task 1",
        branch: "branch-1",
      });
      const op2 = engine.enqueue({
        workerId: "w2",
        taskId: "T-002",
        taskTitle: "Task 2",
        branch: "branch-2",
      });

      expect(op1.id).not.toBe(op2.id);
    });

    test("preserves enqueue order in operations list", () => {
      const engine = makeEngine();
      engine.enqueue({
        workerId: "w1",
        taskId: "T-001",
        taskTitle: "First",
        branch: "b1",
      });
      engine.enqueue({
        workerId: "w2",
        taskId: "T-002",
        taskTitle: "Second",
        branch: "b2",
      });

      const ops = engine.getOperations();
      expect(ops[0].taskId).toBe("T-001");
      expect(ops[1].taskId).toBe("T-002");
    });
  });

  describe("processNext", () => {
    test("returns null when no queued operations", async () => {
      const engine = makeEngine();
      const result = await engine.processNext();
      expect(result).toBeNull();
    });

    test("tries fast-forward first and succeeds", async () => {
      setLogHasCommits();

      const engine = makeEngine();
      engine.enqueue({
        workerId: "w1",
        taskId: "COOR-001",
        taskTitle: "Add affects field",
        branch: "synth-parallel/COOR-001",
      });

      const op = await engine.processNext();
      expect(op!.status).toBe("completed");

      const ffCall = spawnCalls.find((c) => c.cmd.includes("--ff-only"));
      expect(ffCall).toBeDefined();
      expect(ffCall!.cmd).toContain("synth-parallel/COOR-001");
    });

    test("falls back to merge commit when fast-forward fails", async () => {
      setLogHasCommits();
      spawnResults.set("--ff-only", {
        exitCode: 1,
        stdout: "",
        stderr: "Not possible to fast-forward",
      });

      const engine = makeEngine();
      engine.enqueue({
        workerId: "w1",
        taskId: "COOR-001",
        taskTitle: "Add affects field",
        branch: "synth-parallel/COOR-001",
      });

      const op = await engine.processNext();
      expect(op!.status).toBe("completed");

      // Verify merge commit message format
      const mergeCall = spawnCalls.find(
        (c) =>
          c.cmd.includes("merge") &&
          c.cmd.some((arg) => arg.startsWith("feat(")),
      );
      expect(mergeCall).toBeDefined();
      expect(mergeCall!.cmd).toContain(
        "feat(COOR-001): Add affects field",
      );
    });

    test("creates backup tag before merge attempt", async () => {
      setLogHasCommits();

      const engine = makeEngine();
      engine.enqueue({
        workerId: "w1",
        taskId: "COOR-001",
        taskTitle: "Test task",
        branch: "branch-1",
      });

      const op = await engine.processNext();

      // Verify tag was created
      const tagCall = spawnCalls.find(
        (c) => c.cmd[0] === "git" && c.cmd[1] === "tag",
      );
      expect(tagCall).toBeDefined();
      expect(tagCall!.cmd[2]).toMatch(
        /^synth\/pre-merge\/COOR-001\/\d+$/,
      );
      expect(tagCall!.cmd[3]).toBe("HEAD");

      // Operation should store the backup tag
      expect(op!.backupTag).toMatch(
        /^synth\/pre-merge\/COOR-001\/\d+$/,
      );

      // Tag must come before merge
      const tagIdx = spawnCalls.findIndex(
        (c) => c.cmd[0] === "git" && c.cmd[1] === "tag",
      );
      const mergeIdx = spawnCalls.findIndex((c) =>
        c.cmd.includes("--ff-only"),
      );
      expect(tagIdx).toBeLessThan(mergeIdx);
    });

    test("on conflict: sets status to conflicted, aborts merge, resets to backup", async () => {
      setLogHasCommits();
      spawnResults.set("--ff-only", {
        exitCode: 1,
        stdout: "",
        stderr: "Not possible to fast-forward",
      });
      // Use " -m " pattern to match merge commit but not tag (synth/pre-merge)
      spawnResults.set(" -m ", {
        exitCode: 1,
        stdout: "",
        stderr: "CONFLICT (content): Merge conflict in file.ts",
      });

      const engine = makeEngine();
      engine.enqueue({
        workerId: "w1",
        taskId: "COOR-001",
        taskTitle: "Test task",
        branch: "branch-1",
      });

      const op = await engine.processNext();
      expect(op!.status).toBe("conflicted");

      // Verify merge was aborted
      const abortCall = spawnCalls.find((c) =>
        c.cmd.includes("--abort"),
      );
      expect(abortCall).toBeDefined();
      expect(abortCall!.cmd).toEqual(["git", "merge", "--abort"]);

      // Verify HEAD was reset to backup tag
      const resetCall = spawnCalls.find(
        (c) =>
          c.cmd.includes("reset") && c.cmd.includes("--hard"),
      );
      expect(resetCall).toBeDefined();
      expect(op!.backupTag).toBeDefined();
      expect(resetCall!.cmd).toContain(op!.backupTag!);
    });

    test("fails with 'No commits to merge' when branch has no new commits", async () => {
      // git log returns empty stdout → no commits ahead
      spawnResults.set("git log", {
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const engine = makeEngine();
      engine.enqueue({
        workerId: "w1",
        taskId: "COOR-001",
        taskTitle: "Test task",
        branch: "branch-1",
      });

      const op = await engine.processNext();
      expect(op!.status).toBe("failed");
      expect(op!.error).toBe("No commits to merge");

      // Should NOT attempt any merge
      const mergeCall = spawnCalls.find((c) =>
        c.cmd.includes("--ff-only"),
      );
      expect(mergeCall).toBeUndefined();
    });

    test("processes operations in FIFO order", async () => {
      setLogHasCommits();

      const engine = makeEngine();
      engine.enqueue({
        workerId: "w1",
        taskId: "T-001",
        taskTitle: "First",
        branch: "b1",
      });
      engine.enqueue({
        workerId: "w2",
        taskId: "T-002",
        taskTitle: "Second",
        branch: "b2",
      });

      const first = await engine.processNext();
      expect(first!.taskId).toBe("T-001");

      const second = await engine.processNext();
      expect(second!.taskId).toBe("T-002");

      const none = await engine.processNext();
      expect(none).toBeNull();
    });

    test("does not set backup tag when no commits to merge", async () => {
      spawnResults.set("git log", {
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const engine = makeEngine();
      engine.enqueue({
        workerId: "w1",
        taskId: "COOR-001",
        taskTitle: "Test",
        branch: "branch-1",
      });

      const op = await engine.processNext();
      expect(op!.backupTag).toBeUndefined();
    });
  });

  describe("rollbackMerge", () => {
    test("resets HEAD to backup tag of completed operation", async () => {
      setLogHasCommits();

      const engine = makeEngine();
      engine.enqueue({
        workerId: "w1",
        taskId: "COOR-001",
        taskTitle: "Test task",
        branch: "branch-1",
      });
      const op = await engine.processNext();
      spawnCalls = []; // reset to track only rollback calls

      await engine.rollbackMerge(op!.id);

      const resetCall = spawnCalls.find(
        (c) =>
          c.cmd.includes("reset") && c.cmd.includes("--hard"),
      );
      expect(resetCall).toBeDefined();
      expect(op!.backupTag).toBeDefined();
      expect(resetCall!.cmd).toContain(op!.backupTag!);
      expect(resetCall!.cwd).toBe("/repo");
    });

    test("throws for unknown operation ID", async () => {
      const engine = makeEngine();
      await expect(engine.rollbackMerge("unknown-id")).rejects.toThrow(
        "not found",
      );
    });

    test("throws when operation has no backup tag", async () => {
      // "No commits to merge" case produces an operation without a backup tag
      spawnResults.set("git log", {
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const engine = makeEngine();
      const op = engine.enqueue({
        workerId: "w1",
        taskId: "COOR-001",
        taskTitle: "Test",
        branch: "branch-1",
      });

      await engine.processNext();
      await expect(engine.rollbackMerge(op.id)).rejects.toThrow(
        "No backup tag",
      );
    });

    test("throws when git reset fails", async () => {
      setLogHasCommits();
      spawnResults.set("reset --hard", {
        exitCode: 1,
        stdout: "",
        stderr: "fatal: could not read tree",
      });

      const engine = makeEngine();
      engine.enqueue({
        workerId: "w1",
        taskId: "COOR-001",
        taskTitle: "Test",
        branch: "branch-1",
      });
      // processNext succeeds (ff merge) but uses "reset --hard" pattern
      // We need to be careful — the processNext's conflict path also uses reset.
      // Since the ff merge succeeds by default, processNext won't hit reset.

      const op = await engine.processNext();
      await expect(engine.rollbackMerge(op!.id)).rejects.toThrow(
        "Failed to rollback",
      );
    });
  });
});
