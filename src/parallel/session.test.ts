import { describe, test, expect, beforeEach, mock } from "bun:test";

// Track mock state
let writtenFiles: Map<string, unknown> = new Map();
let existingFiles: Map<string, unknown> = new Map();
let removedFiles: string[] = [];
let spawnCalls: { cmd: string[]; cwd?: string }[] = [];
let spawnResults: Map<string, { exitCode: number; stdout: string; stderr: string }> = new Map();

// Mock fs utilities
mock.module("../utils/fs.js", () => ({
  readJson: async <T>(path: string): Promise<T> => {
    const data = existingFiles.get(path);
    if (data === undefined) throw new Error(`File not found: ${path}`);
    return data as T;
  },
  writeJson: async (path: string, data: unknown): Promise<void> => {
    writtenFiles.set(path, data);
  },
  fileExists: async (path: string): Promise<boolean> => {
    return existingFiles.has(path);
  },
  removeFile: async (path: string): Promise<void> => {
    removedFiles.push(path);
    existingFiles.delete(path);
  },
  ensureDir: async () => {},
  dirExists: async () => false,
}));

// Mock git utilities
mock.module("../utils/git.js", () => ({
  listWorktrees: async (cwd: string) => {
    const call = { cmd: ["git", "worktree", "list", "--porcelain"], cwd };
    spawnCalls.push(call);
    const key = "worktree list";
    const override = spawnResults.get(key);
    if (override) {
      // Parse porcelain output into WorktreeInfo[]
      const blocks = override.stdout.trim().split("\n\n");
      const worktrees: { path: string; head: string; branch: string | null }[] = [];
      for (const block of blocks) {
        if (!block.trim()) continue;
        const pathMatch = block.match(/^worktree (.+)$/m);
        const headMatch = block.match(/^HEAD ([0-9a-f]+)$/m);
        const branchMatch = block.match(/^branch (.+)$/m);
        if (pathMatch && headMatch) {
          worktrees.push({
            path: pathMatch[1],
            head: headMatch[1],
            branch: branchMatch ? branchMatch[1] : null,
          });
        }
      }
      return worktrees;
    }
    return [];
  },
  removeWorktree: async (path: string, cwd: string) => {
    spawnCalls.push({ cmd: ["git", "worktree", "remove", "--force", path], cwd });
    const key = `remove:${path}`;
    const override = spawnResults.get(key);
    if (override && override.exitCode !== 0) {
      throw new Error(`Failed to remove worktree at '${path}': ${override.stderr}`);
    }
  },
  deleteBranch: async (name: string, cwd: string, force?: boolean) => {
    const flag = force ? "-D" : "-d";
    spawnCalls.push({ cmd: ["git", "branch", flag, name], cwd });
    const key = `delete-branch:${name}`;
    const override = spawnResults.get(key);
    if (override && override.exitCode !== 0) {
      throw new Error(`Failed to delete branch '${name}': ${override.stderr}`);
    }
  },
  getCurrentBranch: async () => "main",
  checkoutBranch: async () => {},
  listBranches: async () => [],
  listTags: async () => [],
  deleteTag: async () => {},
  gitLog: async () => "",
}));

// Mock tasks/store (imported by session.ts for reconciliation)
mock.module("../tasks/store.js", () => ({
  loadTasks: async () => ({ tasks: [] }),
  saveTasks: async () => {},
  updateTaskStatus: (taskFile: unknown) => taskFile,
}));

import {
  saveParallelSession,
  loadParallelSession,
  deleteParallelSession,
  findOrphanedWorktrees,
  cleanupOrphanedWorktrees,
  type ParallelSessionState,
} from "./session.js";
import type { SessionPaths } from "../sessions/types.js";

const mockSessionPaths: SessionPaths = {
  root: "/sessions/repo/test-session",
  prd: "/sessions/repo/test-session/prd.md",
  tasks: "/sessions/repo/test-session/tasks.json",
  progress: "/sessions/repo/test-session/progress.md",
  run: "/sessions/repo/test-session/run.json",
  lock: "/sessions/repo/test-session/lock",
  logs: "/sessions/repo/test-session/logs",
  summary: "/sessions/repo/test-session/summary.md",
  interview: "/sessions/repo/test-session/interview.json",
  reviewRoot: "/sessions/repo/test-session/review",
  reviewFindings: "/sessions/repo/test-session/review/findings.md",
  reviewTasks: "/sessions/repo/test-session/review/tasks.json",
  reviewProgress: "/sessions/repo/test-session/review/progress.md",
  reviewConversation: "/sessions/repo/test-session/review/conversation.json",
  sessionLog: "/sessions/repo/test-session/session.log",
};

const sessionFilePath = "/sessions/repo/test-session/parallel-session.json";

function makeState(overrides?: Partial<ParallelSessionState>): ParallelSessionState {
  return {
    sessionId: "test-session-123",
    taskGraph: {
      groups: [{ depth: 0, taskIds: ["T-001", "T-002"] }],
      cyclicTaskIds: [],
      maxParallelism: 2,
      recommendParallel: true,
      nodes: [
        ["T-001", { taskId: "T-001", depth: 0, dependsOn: [], dependedBy: ["T-003"] }],
        ["T-002", { taskId: "T-002", depth: 0, dependsOn: [], dependedBy: ["T-003"] }],
        ["T-003", { taskId: "T-003", depth: 1, dependsOn: ["T-001", "T-002"], dependedBy: [] }],
      ],
    },
    lastCompletedGroupIndex: 0,
    mergedTaskIds: ["T-001"],
    failedTaskIds: [],
    requeuedTaskIds: [],
    sessionStartTag: "synth/session-start/abc12345",
    sessionBranch: "synth-session/abc12345",
    originalBranch: "main",
    ...overrides,
  };
}

beforeEach(() => {
  writtenFiles = new Map();
  existingFiles = new Map();
  removedFiles = [];
  spawnCalls = [];
  spawnResults = new Map();
});

describe("saveParallelSession", () => {
  test("writes state to parallel-session.json", async () => {
    const state = makeState();
    await saveParallelSession(mockSessionPaths, state);

    expect(writtenFiles.has(sessionFilePath)).toBe(true);
    const written = writtenFiles.get(sessionFilePath) as ParallelSessionState;
    expect(written.sessionId).toBe("test-session-123");
  });

  test("includes all required fields", async () => {
    const state = makeState({
      lastCompletedGroupIndex: 2,
      mergedTaskIds: ["T-001", "T-002"],
      failedTaskIds: ["T-004"],
      requeuedTaskIds: ["T-005"],
    });
    await saveParallelSession(mockSessionPaths, state);

    const written = writtenFiles.get(sessionFilePath) as ParallelSessionState;
    expect(written.sessionId).toBe("test-session-123");
    expect(written.taskGraph.groups).toHaveLength(1);
    expect(written.taskGraph.nodes).toHaveLength(3);
    expect(written.taskGraph.cyclicTaskIds).toEqual([]);
    expect(written.taskGraph.maxParallelism).toBe(2);
    expect(written.taskGraph.recommendParallel).toBe(true);
    expect(written.lastCompletedGroupIndex).toBe(2);
    expect(written.mergedTaskIds).toEqual(["T-001", "T-002"]);
    expect(written.failedTaskIds).toEqual(["T-004"]);
    expect(written.requeuedTaskIds).toEqual(["T-005"]);
    expect(written.sessionStartTag).toBe("synth/session-start/abc12345");
    expect(written.sessionBranch).toBe("synth-session/abc12345");
    expect(written.originalBranch).toBe("main");
  });
});

describe("loadParallelSession", () => {
  test("returns null when file does not exist", async () => {
    const result = await loadParallelSession(mockSessionPaths);
    expect(result).toBeNull();
  });

  test("deserializes saved state with Map-compatible nodes", async () => {
    const state = makeState();
    existingFiles.set(sessionFilePath, state);

    const loaded = await loadParallelSession(mockSessionPaths);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe("test-session-123");

    // Nodes are stored as [key, value] tuples — can reconstruct Map
    const nodesMap = new Map(loaded!.taskGraph.nodes);
    expect(nodesMap.size).toBe(3);
    expect(nodesMap.get("T-001")!.taskId).toBe("T-001");
    expect(nodesMap.get("T-001")!.depth).toBe(0);
    expect(nodesMap.get("T-001")!.dependedBy).toEqual(["T-003"]);
    expect(nodesMap.get("T-003")!.dependsOn).toEqual(["T-001", "T-002"]);
  });

  test("preserves all state fields through save/load cycle", async () => {
    const state = makeState({
      lastCompletedGroupIndex: 1,
      failedTaskIds: ["T-004"],
      requeuedTaskIds: ["T-004"],
    });

    // Simulate save then load
    await saveParallelSession(mockSessionPaths, state);
    const saved = writtenFiles.get(sessionFilePath) as ParallelSessionState;
    existingFiles.set(sessionFilePath, saved);

    const loaded = await loadParallelSession(mockSessionPaths);
    expect(loaded!.lastCompletedGroupIndex).toBe(1);
    expect(loaded!.failedTaskIds).toEqual(["T-004"]);
    expect(loaded!.requeuedTaskIds).toEqual(["T-004"]);
    expect(loaded!.sessionStartTag).toBe("synth/session-start/abc12345");
    expect(loaded!.sessionBranch).toBe("synth-session/abc12345");
    expect(loaded!.originalBranch).toBe("main");
  });
});

describe("deleteParallelSession", () => {
  test("removes the session file", async () => {
    existingFiles.set(sessionFilePath, makeState());
    await deleteParallelSession(mockSessionPaths);

    expect(removedFiles).toContain(sessionFilePath);
  });

  test("does not throw when file does not exist", async () => {
    // removeFile is a no-op when file doesn't exist
    await expect(deleteParallelSession(mockSessionPaths)).resolves.toBeUndefined();
  });
});

describe("findOrphanedWorktrees", () => {
  test("returns paths of worktrees with synth-parallel branches", async () => {
    spawnResults.set("worktree list", {
      exitCode: 0,
      stdout: [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /worktrees/worker-1",
        "HEAD def456",
        "branch refs/heads/synth-parallel/T-001",
        "",
        "worktree /worktrees/worker-2",
        "HEAD 789abc",
        "branch refs/heads/synth-parallel/T-002",
        "",
      ].join("\n"),
      stderr: "",
    });

    const orphaned = await findOrphanedWorktrees("/repo");
    expect(orphaned).toEqual(["/worktrees/worker-1", "/worktrees/worker-2"]);
  });

  test("excludes worktrees without synth-parallel branches", async () => {
    spawnResults.set("worktree list", {
      exitCode: 0,
      stdout: [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /worktrees/feature",
        "HEAD def456",
        "branch refs/heads/feature/other",
        "",
      ].join("\n"),
      stderr: "",
    });

    const orphaned = await findOrphanedWorktrees("/repo");
    expect(orphaned).toEqual([]);
  });

  test("returns empty array when no worktrees exist", async () => {
    const orphaned = await findOrphanedWorktrees("/repo");
    expect(orphaned).toEqual([]);
  });
});

describe("cleanupOrphanedWorktrees", () => {
  test("removes orphaned worktrees and their branches", async () => {
    spawnResults.set("worktree list", {
      exitCode: 0,
      stdout: [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /worktrees/worker-1",
        "HEAD def456",
        "branch refs/heads/synth-parallel/T-001",
        "",
        "worktree /worktrees/worker-2",
        "HEAD 789abc",
        "branch refs/heads/synth-parallel/T-002",
        "",
      ].join("\n"),
      stderr: "",
    });

    await cleanupOrphanedWorktrees("/repo");

    // Should have removed both worktrees
    const removeCalls = spawnCalls.filter(
      (c) => c.cmd.includes("worktree") && c.cmd.includes("remove"),
    );
    expect(removeCalls).toHaveLength(2);
    expect(removeCalls[0].cmd).toContain("/worktrees/worker-1");
    expect(removeCalls[1].cmd).toContain("/worktrees/worker-2");

    // Should have deleted both branches
    const branchDeletes = spawnCalls.filter(
      (c) => c.cmd.includes("branch") && c.cmd.includes("-D"),
    );
    expect(branchDeletes).toHaveLength(2);
    expect(branchDeletes[0].cmd).toContain("synth-parallel/T-001");
    expect(branchDeletes[1].cmd).toContain("synth-parallel/T-002");
  });

  test("skips non-synth-parallel worktrees", async () => {
    spawnResults.set("worktree list", {
      exitCode: 0,
      stdout: [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /worktrees/other",
        "HEAD def456",
        "branch refs/heads/feature/something",
        "",
      ].join("\n"),
      stderr: "",
    });

    await cleanupOrphanedWorktrees("/repo");

    const removeCalls = spawnCalls.filter(
      (c) => c.cmd.includes("worktree") && c.cmd.includes("remove"),
    );
    expect(removeCalls).toHaveLength(0);
  });

  test("continues cleanup even if one worktree removal fails", async () => {
    spawnResults.set("worktree list", {
      exitCode: 0,
      stdout: [
        "worktree /worktrees/worker-1",
        "HEAD def456",
        "branch refs/heads/synth-parallel/T-001",
        "",
        "worktree /worktrees/worker-2",
        "HEAD 789abc",
        "branch refs/heads/synth-parallel/T-002",
        "",
      ].join("\n"),
      stderr: "",
    });

    // Make first worktree removal fail
    spawnResults.set("remove:/worktrees/worker-1", {
      exitCode: 1,
      stdout: "",
      stderr: "error: not a git worktree",
    });

    await cleanupOrphanedWorktrees("/repo");

    // Should still attempt to clean up the second worktree
    const removeCalls = spawnCalls.filter(
      (c) => c.cmd.includes("worktree") && c.cmd.includes("remove"),
    );
    // First one tried and failed, second one tried and succeeded
    expect(removeCalls.length).toBeGreaterThanOrEqual(1);

    // Should still try to delete branch for second worktree
    const branchDeletes = spawnCalls.filter(
      (c) => c.cmd.includes("branch") && c.cmd.includes("-D"),
    );
    expect(branchDeletes.some((c) => c.cmd.includes("synth-parallel/T-002"))).toBe(true);
  });
});
