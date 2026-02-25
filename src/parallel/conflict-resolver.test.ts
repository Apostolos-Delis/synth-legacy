import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { AgentAdapter, AgentExecutionHandle, AgentExecuteOptions } from "../agents/types.js";
import type { MergeOperation } from "./merge-engine.js";

// --- Mock state ---

let spawnCalls: { cmd: string[]; cwd?: string }[] = [];
let spawnResults: Map<string, { exitCode: number; stdout: string; stderr: string }> = new Map();
let resolveWithAiResults: Map<string, string | null> = new Map();
let resolveWithAiCalls: { file: string; taskId: string }[] = [];
let writtenFiles: Map<string, string> = new Map();
let unlinkedFiles: string[] = [];

function defaultSpawnResult() {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, timings: { spawnMs: 0, firstStdoutMs: null, firstStderrMs: null, totalMs: 0 } };
}

function matchSpawn(cmd: string[]): { exitCode: number; stdout: string; stderr: string } {
  // Try exact match first
  const key = cmd.join(" ");
  if (spawnResults.has(key)) {
    return spawnResults.get(key)!;
  }

  // Try prefix match for common patterns
  for (const [pattern, result] of spawnResults) {
    if (key.startsWith(pattern)) {
      return result;
    }
  }

  return { exitCode: 0, stdout: "", stderr: "" };
}

mock.module("../utils/process.js", () => ({
  spawn: (opts: { cmd: string[]; cwd?: string }) => {
    spawnCalls.push({ cmd: opts.cmd, cwd: opts.cwd });
    const result = matchSpawn(opts.cmd);
    return {
      pid: 1,
      promise: Promise.resolve({ ...defaultSpawnResult(), ...result }),
      interrupt: () => {},
    };
  },
}));

mock.module("node:fs", () => ({
  writeFileSync: (path: string, content: string) => {
    writtenFiles.set(path, content);
  },
  unlinkSync: (path: string) => {
    unlinkedFiles.push(path);
  },
}));

mock.module("./ai-resolver.js", () => ({
  resolveWithAi: async (conflictInfo: { file: string; taskId: string; context?: { prd: string } }, _agent: unknown, _cwd: string) => {
    resolveWithAiCalls.push({ file: conflictInfo.file, taskId: conflictInfo.taskId });
    return resolveWithAiResults.get(conflictInfo.file) ?? null;
  },
}));

import { resolveConflicts, wrapAgentAsAiAgent } from "./conflict-resolver.js";

// --- Helpers ---

function makeAgent(stdout = "resolved"): AgentAdapter {
  return {
    name: "mock",
    detect: async () => ({ available: true }),
    execute: (_prompt: string, _options: AgentExecuteOptions): AgentExecutionHandle => ({
      pid: 1,
      promise: Promise.resolve({ exitCode: 0, stdout, stderr: "", timedOut: false }),
      interrupt: () => {},
    }),
    dispose: () => {},
  };
}

function makeOperation(overrides?: Partial<MergeOperation>): MergeOperation {
  return {
    id: "merge-1",
    taskId: "T-1",
    taskTitle: "Test task",
    sourceBranch: "synth-parallel/T-1",
    status: "conflicted",
    conflictedFiles: ["src/index.ts"],
    ...overrides,
  };
}

function makeContext() {
  return {
    prd: "PRD",
    taskDescription: "Task description",
    acceptanceCriteria: ["Do the thing"],
    mergedTasks: [],
  };
}

// --- Tests ---

beforeEach(() => {
  spawnCalls = [];
  spawnResults = new Map();
  resolveWithAiResults = new Map();
  resolveWithAiCalls = [];
  writtenFiles = new Map();
  unlinkedFiles = [];
});

describe("resolveConflicts", () => {
  test("returns false when no conflicted files", async () => {
    const result = await resolveConflicts(
      makeOperation({ conflictedFiles: [] }),
      "/repo",
      makeAgent(),
      makeContext(),
    );

    expect(result.resolved).toBe(false);
    expect(result.resolvedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  test("returns false when conflictedFiles is undefined", async () => {
    const result = await resolveConflicts(
      makeOperation({ conflictedFiles: undefined }),
      "/repo",
      makeAgent(),
      makeContext(),
    );

    expect(result.resolved).toBe(false);
  });

  test("skips resolution when more than 10 conflicted files (confidence gating)", async () => {
    const files = Array.from({ length: 11 }, (_, i) => `file${i}.ts`);
    const result = await resolveConflicts(
      makeOperation({ conflictedFiles: files }),
      "/repo",
      makeAgent(),
      makeContext(),
    );

    expect(result.resolved).toBe(false);
    expect(result.failedCount).toBe(11);
    // Should not have attempted any git merge
    expect(spawnCalls.length).toBe(0);
  });

  test("allows resolution with exactly 10 files", async () => {
    const files = Array.from({ length: 10 }, (_, i) => `file${i}.ts`);
    for (const f of files) {
      resolveWithAiResults.set(f, `resolved ${f}`);
    }

    // Set up spawn results for merge and git operations
    spawnResults.set("git merge --squash", { exitCode: 1, stdout: "", stderr: "CONFLICT" });
    spawnResults.set("git show", { exitCode: 0, stdout: "content", stderr: "" });
    spawnResults.set("git hash-object", { exitCode: 0, stdout: "abc123\n", stderr: "" });
    spawnResults.set("git ls-files", { exitCode: 0, stdout: "100644 abc123 0\tfile.ts", stderr: "" });
    spawnResults.set("git update-index", { exitCode: 0, stdout: "", stderr: "" });
    spawnResults.set("git commit", { exitCode: 0, stdout: "", stderr: "" });

    const result = await resolveConflicts(
      makeOperation({ conflictedFiles: files }),
      "/repo",
      makeAgent(),
      makeContext(),
    );

    expect(result.resolved).toBe(true);
    expect(result.resolvedCount).toBe(10);
  });

  test("re-starts merge in squash mode", async () => {
    resolveWithAiResults.set("src/index.ts", "resolved content");

    spawnResults.set("git merge --squash", { exitCode: 1, stdout: "", stderr: "CONFLICT" });
    spawnResults.set("git show", { exitCode: 0, stdout: "content", stderr: "" });
    spawnResults.set("git hash-object", { exitCode: 0, stdout: "abc123\n", stderr: "" });
    spawnResults.set("git ls-files", { exitCode: 0, stdout: "100644 abc123 0\tsrc/index.ts", stderr: "" });
    spawnResults.set("git update-index", { exitCode: 0, stdout: "", stderr: "" });
    spawnResults.set("git commit", { exitCode: 0, stdout: "", stderr: "" });

    await resolveConflicts(makeOperation(), "/repo", makeAgent(), makeContext());

    const mergeCall = spawnCalls.find(
      (c) => c.cmd.includes("merge") && c.cmd.includes("--squash"),
    );
    expect(mergeCall).toBeDefined();
    expect(mergeCall!.cmd).toContain("synth-parallel/T-1");
  });

  test("resets if merge fails with unexpected exit code", async () => {
    spawnResults.set("git merge --squash", { exitCode: 128, stdout: "", stderr: "fatal: not a git repo" });
    spawnResults.set("git reset --hard HEAD", { exitCode: 0, stdout: "", stderr: "" });

    const result = await resolveConflicts(makeOperation(), "/repo", makeAgent(), makeContext());

    expect(result.resolved).toBe(false);
    expect(result.failedCount).toBe(1);
    const resetCall = spawnCalls.find(
      (c) => c.cmd.includes("reset") && c.cmd.includes("--hard"),
    );
    expect(resetCall).toBeDefined();
  });

  test("extracts three-way merge data from git index stages", async () => {
    resolveWithAiResults.set("src/index.ts", "resolved");

    spawnResults.set("git merge --squash", { exitCode: 1, stdout: "", stderr: "" });
    spawnResults.set("git show :1:src/index.ts", { exitCode: 0, stdout: "base content", stderr: "" });
    spawnResults.set("git show :2:src/index.ts", { exitCode: 0, stdout: "ours content", stderr: "" });
    spawnResults.set("git show :3:src/index.ts", { exitCode: 0, stdout: "theirs content", stderr: "" });
    spawnResults.set("git hash-object", { exitCode: 0, stdout: "abc123\n", stderr: "" });
    spawnResults.set("git ls-files", { exitCode: 0, stdout: "100644 abc123 0\tsrc/index.ts", stderr: "" });
    spawnResults.set("git update-index", { exitCode: 0, stdout: "", stderr: "" });
    spawnResults.set("git commit", { exitCode: 0, stdout: "", stderr: "" });

    await resolveConflicts(makeOperation(), "/repo", makeAgent(), makeContext());

    // Verify git show was called for all 3 stages
    const showCalls = spawnCalls.filter((c) => c.cmd[0] === "git" && c.cmd[1] === "show");
    expect(showCalls.length).toBe(3);
    expect(showCalls.some((c) => c.cmd[2] === ":1:src/index.ts")).toBe(true);
    expect(showCalls.some((c) => c.cmd[2] === ":2:src/index.ts")).toBe(true);
    expect(showCalls.some((c) => c.cmd[2] === ":3:src/index.ts")).toBe(true);
  });

  test("calls resolveWithAi for each conflicted file", async () => {
    resolveWithAiResults.set("src/a.ts", "resolved a");
    resolveWithAiResults.set("src/b.ts", "resolved b");

    spawnResults.set("git merge --squash", { exitCode: 1, stdout: "", stderr: "" });
    spawnResults.set("git show", { exitCode: 0, stdout: "content", stderr: "" });
    spawnResults.set("git hash-object", { exitCode: 0, stdout: "abc123\n", stderr: "" });
    spawnResults.set("git ls-files", { exitCode: 0, stdout: "100644 abc123 0\tfile", stderr: "" });
    spawnResults.set("git update-index", { exitCode: 0, stdout: "", stderr: "" });
    spawnResults.set("git commit", { exitCode: 0, stdout: "", stderr: "" });

    await resolveConflicts(
      makeOperation({ conflictedFiles: ["src/a.ts", "src/b.ts"] }),
      "/repo",
      makeAgent(),
      makeContext(),
    );

    expect(resolveWithAiCalls.length).toBe(2);
    expect(resolveWithAiCalls.some((c) => c.file === "src/a.ts")).toBe(true);
    expect(resolveWithAiCalls.some((c) => c.file === "src/b.ts")).toBe(true);
  });

  test("commits on success with task info in message", async () => {
    resolveWithAiResults.set("src/index.ts", "resolved content");

    spawnResults.set("git merge --squash", { exitCode: 1, stdout: "", stderr: "" });
    spawnResults.set("git show", { exitCode: 0, stdout: "content", stderr: "" });
    spawnResults.set("git hash-object", { exitCode: 0, stdout: "abc123\n", stderr: "" });
    spawnResults.set("git ls-files", { exitCode: 0, stdout: "100644 abc123 0\tsrc/index.ts", stderr: "" });
    spawnResults.set("git update-index", { exitCode: 0, stdout: "", stderr: "" });
    spawnResults.set("git commit", { exitCode: 0, stdout: "", stderr: "" });

    const result = await resolveConflicts(makeOperation(), "/repo", makeAgent(), makeContext());

    expect(result.resolved).toBe(true);
    expect(result.resolvedCount).toBe(1);
    expect(result.failedCount).toBe(0);

    const commitCall = spawnCalls.find((c) => c.cmd.includes("commit"));
    expect(commitCall).toBeDefined();
    expect(commitCall!.cmd.some((arg) => arg.includes("T-1"))).toBe(true);
    expect(commitCall!.cmd.some((arg) => arg.includes("AI-resolved"))).toBe(true);
  });

  test("resets and returns failure when any file cannot be resolved", async () => {
    resolveWithAiResults.set("src/a.ts", "resolved a");
    // src/b.ts returns null (not resolvable)

    spawnResults.set("git merge --squash", { exitCode: 1, stdout: "", stderr: "" });
    spawnResults.set("git show", { exitCode: 0, stdout: "content", stderr: "" });
    spawnResults.set("git hash-object", { exitCode: 0, stdout: "abc123\n", stderr: "" });
    spawnResults.set("git ls-files", { exitCode: 0, stdout: "100644 abc123 0\tfile", stderr: "" });
    spawnResults.set("git update-index", { exitCode: 0, stdout: "", stderr: "" });
    spawnResults.set("git reset --hard HEAD", { exitCode: 0, stdout: "", stderr: "" });

    const result = await resolveConflicts(
      makeOperation({ conflictedFiles: ["src/a.ts", "src/b.ts"] }),
      "/repo",
      makeAgent(),
      makeContext(),
    );

    expect(result.resolved).toBe(false);
    expect(result.resolvedCount).toBe(1);
    expect(result.failedCount).toBe(1);

    const resetCall = spawnCalls.find(
      (c) => c.cmd.includes("reset") && c.cmd.includes("--hard"),
    );
    expect(resetCall).toBeDefined();
  });

  test("resets when commit fails", async () => {
    resolveWithAiResults.set("src/index.ts", "resolved");

    spawnResults.set("git merge --squash", { exitCode: 1, stdout: "", stderr: "" });
    spawnResults.set("git show", { exitCode: 0, stdout: "content", stderr: "" });
    spawnResults.set("git hash-object", { exitCode: 0, stdout: "abc123\n", stderr: "" });
    spawnResults.set("git ls-files", { exitCode: 0, stdout: "100644 abc123 0\tsrc/index.ts", stderr: "" });
    spawnResults.set("git update-index", { exitCode: 0, stdout: "", stderr: "" });
    spawnResults.set("git commit", { exitCode: 1, stdout: "", stderr: "commit failed" });
    spawnResults.set("git reset --hard HEAD", { exitCode: 0, stdout: "", stderr: "" });

    const result = await resolveConflicts(makeOperation(), "/repo", makeAgent(), makeContext());

    expect(result.resolved).toBe(false);
  });
});

describe("wrapAgentAsAiAgent", () => {
  test("wraps AgentAdapter to AiAgent interface", async () => {
    const agent = makeAgent("resolved output");
    const aiAgent = wrapAgentAsAiAgent(agent);

    const result = await aiAgent.resolve("test prompt", "/repo");
    expect(result).toBe("resolved output");
  });

  test("throws when agent execution fails", async () => {
    const agent: AgentAdapter = {
      name: "failing-mock",
      detect: async () => ({ available: true }),
      execute: () => ({
        pid: 1,
        promise: Promise.resolve({ exitCode: 1, stdout: "", stderr: "agent error", timedOut: false }),
        interrupt: () => {},
      }),
      dispose: () => {},
    };

    const aiAgent = wrapAgentAsAiAgent(agent);

    await expect(aiAgent.resolve("prompt", "/repo")).rejects.toThrow("exit code 1");
  });
});
