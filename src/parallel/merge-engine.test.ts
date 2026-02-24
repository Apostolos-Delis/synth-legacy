import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  MergeEngine,
  parseConflictedFiles,
  getConflictedFilesFromDiff,
} from "./merge-engine.js";

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

    test("squash-merges and commits with feat() message", async () => {
      setLogHasCommits();
      // squash merge succeeds, staged changes exist
      spawnResults.set("--cached --quiet", {
        exitCode: 1,
        stdout: "",
        stderr: "",
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

      const squashCall = spawnCalls.find((c) => c.cmd.includes("--squash"));
      expect(squashCall).toBeDefined();
      expect(squashCall!.cmd).toContain("synth-parallel/COOR-001");

      // Verify commit message format
      const commitCall = spawnCalls.find(
        (c) =>
          c.cmd.includes("commit") &&
          c.cmd.some((arg) => arg.startsWith("feat(")),
      );
      expect(commitCall).toBeDefined();
      expect(commitCall!.cmd).toContain(
        "feat(COOR-001): Add affects field",
      );
    });

    test("fails when squash merge produces no changes", async () => {
      setLogHasCommits();
      // squash merge succeeds but no staged changes
      spawnResults.set("--cached --quiet", {
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const engine = makeEngine();
      engine.enqueue({
        workerId: "w1",
        taskId: "COOR-001",
        taskTitle: "Add affects field",
        branch: "synth-parallel/COOR-001",
      });

      const op = await engine.processNext();
      expect(op!.status).toBe("failed");
      expect(op!.error).toBe("Squash merge produced no changes");
    });

    test("creates backup tag before squash merge attempt", async () => {
      setLogHasCommits();
      spawnResults.set("--cached --quiet", {
        exitCode: 1,
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

      // Tag must come before squash merge
      const tagIdx = spawnCalls.findIndex(
        (c) => c.cmd[0] === "git" && c.cmd[1] === "tag",
      );
      const squashIdx = spawnCalls.findIndex((c) =>
        c.cmd.includes("--squash"),
      );
      expect(tagIdx).toBeLessThan(squashIdx);
    });

    test("on conflict: sets status to conflicted and resets to backup tag", async () => {
      setLogHasCommits();
      spawnResults.set("--squash", {
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

      // Squash merge doesn't set MERGE_HEAD, so no merge --abort — only reset --hard
      const abortCall = spawnCalls.find((c) =>
        c.cmd.includes("--abort"),
      );
      expect(abortCall).toBeUndefined();

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
      spawnResults.set("--cached --quiet", {
        exitCode: 1,
        stdout: "",
        stderr: "",
      });

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

  describe("parseConflictedFiles", () => {
    test("returns empty array for empty input", () => {
      expect(parseConflictedFiles("")).toEqual([]);
    });

    test("returns empty array when no CONFLICT lines present", () => {
      const stderr =
        "Auto-merging src/index.ts\nAlready up to date.\n";
      expect(parseConflictedFiles(stderr)).toEqual([]);
    });

    test("extracts file from content conflict", () => {
      const stderr =
        "CONFLICT (content): Merge conflict in src/utils/helper.ts";
      expect(parseConflictedFiles(stderr)).toEqual([
        "src/utils/helper.ts",
      ]);
    });

    test("extracts file from add/add conflict", () => {
      const stderr =
        "CONFLICT (add/add): Merge conflict in newfile.ts";
      expect(parseConflictedFiles(stderr)).toEqual(["newfile.ts"]);
    });

    test("extracts multiple conflicted files", () => {
      const stderr = [
        "Auto-merging src/a.ts",
        "CONFLICT (content): Merge conflict in src/a.ts",
        "Auto-merging src/b.ts",
        "CONFLICT (content): Merge conflict in src/b.ts",
        "CONFLICT (add/add): Merge conflict in src/c.ts",
        "Automatic merge failed; fix conflicts and then commit the result.",
      ].join("\n");
      expect(parseConflictedFiles(stderr)).toEqual([
        "src/a.ts",
        "src/b.ts",
        "src/c.ts",
      ]);
    });

    test("handles file paths with spaces", () => {
      const stderr =
        "CONFLICT (content): Merge conflict in src/my file.ts";
      expect(parseConflictedFiles(stderr)).toEqual([
        "src/my file.ts",
      ]);
    });

    test("handles deeply nested file paths", () => {
      const stderr =
        "CONFLICT (content): Merge conflict in src/a/b/c/d/e/file.ts";
      expect(parseConflictedFiles(stderr)).toEqual([
        "src/a/b/c/d/e/file.ts",
      ]);
    });

    // modify/delete conflicts use a different message format that ends with
    // "...left in tree." so the regex captures "tree." instead of the file path.
    // This documents the current limitation.
    test("does not extract correct file from modify/delete conflict", () => {
      const stderr =
        "CONFLICT (modify/delete): src/old.ts deleted in HEAD and modified in feature. Version feature of src/old.ts left in tree.";
      const result = parseConflictedFiles(stderr);
      // Current regex grabs text after the last "in" → "tree."
      expect(result).toEqual(["tree."]);
    });

    // rename/delete conflicts also use a different format.
    test("does not extract correct file from rename/delete conflict", () => {
      const stderr =
        "CONFLICT (rename/delete): src/old.ts renamed in feature and deleted in HEAD.";
      const result = parseConflictedFiles(stderr);
      // Current regex grabs text after the last "in" → "HEAD."
      expect(result).toEqual(["HEAD."]);
    });

    test("handles mixed conflict types in single output", () => {
      const stderr = [
        "CONFLICT (content): Merge conflict in src/a.ts",
        "CONFLICT (modify/delete): src/b.ts deleted in HEAD and modified in feature. Version feature of src/b.ts left in tree.",
      ].join("\n");
      const result = parseConflictedFiles(stderr);
      expect(result).toEqual(["src/a.ts", "tree."]);
    });

    test("ignores trailing whitespace on conflict lines", () => {
      const stderr =
        "CONFLICT (content): Merge conflict in src/file.ts   ";
      expect(parseConflictedFiles(stderr)).toEqual(["src/file.ts"]);
    });

    test("extracts file from rename/rename conflict", () => {
      const stderr =
        "CONFLICT (rename/rename): Rename src/old.ts->src/new-a.ts in HEAD. Rename src/old.ts->src/new-b.ts in feature.";
      // The regex captures text after last "in" → "feature." which is imperfect,
      // but documents current behavior for this conflict type.
      const result = parseConflictedFiles(stderr);
      expect(result).toEqual(["feature."]);
    });
  });

  describe("getConflictedFilesFromDiff", () => {
    test("returns file paths from git diff output", async () => {
      spawnResults.set("--diff-filter=U", {
        exitCode: 0,
        stdout: "src/a.ts\nsrc/b.ts\n",
        stderr: "",
      });

      const result = await getConflictedFilesFromDiff("/repo");
      expect(result).toEqual(["src/a.ts", "src/b.ts"]);
    });

    test("returns empty array when git diff fails", async () => {
      spawnResults.set("--diff-filter=U", {
        exitCode: 1,
        stdout: "",
        stderr: "fatal: not a git repository",
      });

      const result = await getConflictedFilesFromDiff("/repo");
      expect(result).toEqual([]);
    });

    test("returns empty array when no unmerged files", async () => {
      spawnResults.set("--diff-filter=U", {
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const result = await getConflictedFilesFromDiff("/repo");
      expect(result).toEqual([]);
    });
  });

  describe("processNext fallback to getConflictedFilesFromDiff", () => {
    test("falls back to git diff when parseConflictedFiles returns empty", async () => {
      setLogHasCommits();
      // Squash merge fails but stderr has no CONFLICT lines
      spawnResults.set("--squash", {
        exitCode: 1,
        stdout: "",
        stderr: "Automatic merge failed; fix conflicts and then commit the result.",
      });
      // The fallback git diff should find the conflicted files
      spawnResults.set("--diff-filter=U", {
        exitCode: 0,
        stdout: "src/x.ts\nsrc/y.ts\n",
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
      expect(op!.status).toBe("conflicted");
      expect(op!.conflictedFiles).toEqual(["src/x.ts", "src/y.ts"]);

      // Verify git diff was called as fallback
      const diffCall = spawnCalls.find((c) =>
        c.cmd.includes("--diff-filter=U"),
      );
      expect(diffCall).toBeDefined();
    });

    test("does not call git diff fallback when parseConflictedFiles finds files", async () => {
      setLogHasCommits();
      spawnResults.set("--squash", {
        exitCode: 1,
        stdout: "",
        stderr: "CONFLICT (content): Merge conflict in src/file.ts",
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
      expect(op!.conflictedFiles).toEqual(["src/file.ts"]);

      // git diff should NOT have been called
      const diffCall = spawnCalls.find((c) =>
        c.cmd.includes("--diff-filter=U"),
      );
      expect(diffCall).toBeUndefined();
    });
  });

  describe("rollbackMerge", () => {
    test("resets HEAD to backup tag of completed operation", async () => {
      setLogHasCommits();
      spawnResults.set("--cached --quiet", {
        exitCode: 1,
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
