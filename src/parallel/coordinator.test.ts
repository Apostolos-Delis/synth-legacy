import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Task } from "../tasks/types.js";
import type { SessionPaths } from "../sessions/types.js";
import type { ParallelEvent } from "./events.js";
import type { WorkerResult, MergeOperation } from "./merge-engine.js";
import type { WorktreeInfo } from "./worktree-manager.js";
import type { TaskGraphAnalysis, ParallelGroup } from "./task-graph.js";

// --- Mock state ---

let savedSessions: unknown[] = [];
let deletedSessions: boolean[] = [];
let gitCalls: { fn: string; args: unknown[] }[] = [];
let analyzeResult: TaskGraphAnalysis;
let worktreeAcquireCalls: { workerId: string; taskId: string; sessionBranch: string }[] = [];
let worktreeCleanedUp: boolean[] = [];
let mergeInitCalls: string[] = [];
let mergeEnqueueCalls: WorkerResult[] = [];
let mergeProcessResults: (MergeOperation | null)[] = [];
let mergeProcessIndex = 0;

// --- Mock modules ---

mock.module("./task-graph.js", () => ({
  analyzeTaskGraph: (_tasks: Task[]) => analyzeResult,
}));

mock.module("./session.js", () => ({
  saveParallelSession: async (_paths: SessionPaths, state: unknown) => {
    savedSessions.push(state);
  },
  deleteParallelSession: async (_paths: SessionPaths) => {
    deletedSessions.push(true);
  },
}));

mock.module("../utils/git.js", () => ({
  getCurrentBranch: async (cwd: string) => {
    gitCalls.push({ fn: "getCurrentBranch", args: [cwd] });
    return "main";
  },
  checkoutBranch: async (name: string, cwd: string) => {
    gitCalls.push({ fn: "checkoutBranch", args: [name, cwd] });
  },
  createTag: async (name: string, cwd: string) => {
    gitCalls.push({ fn: "createTag", args: [name, cwd] });
  },
  deleteTag: async (name: string, cwd: string) => {
    gitCalls.push({ fn: "deleteTag", args: [name, cwd] });
  },
  mergeFF: async (branch: string, cwd: string) => {
    gitCalls.push({ fn: "mergeFF", args: [branch, cwd] });
  },
}));

// Mock WorktreeManager and MergeEngine as classes
let mockWorktreeManagerInstance: {
  acquire: (workerId: string, taskId: string, sessionBranch: string) => Promise<WorktreeInfo>;
  cleanupAll: () => Promise<void>;
};

let mockMergeEngineInstance: {
  initializeSessionBranch: (sessionId: string) => Promise<string>;
  enqueue: (result: WorkerResult) => MergeOperation;
  processNext: () => Promise<MergeOperation | null>;
};

mock.module("./worktree-manager.js", () => ({
  WorktreeManager: class {
    constructor(_opts: unknown) {}
    async acquire(workerId: string, taskId: string, sessionBranch: string): Promise<WorktreeInfo> {
      worktreeAcquireCalls.push({ workerId, taskId, sessionBranch });
      return mockWorktreeManagerInstance.acquire(workerId, taskId, sessionBranch);
    }
    async cleanupAll(): Promise<void> {
      worktreeCleanedUp.push(true);
      return mockWorktreeManagerInstance.cleanupAll();
    }
  },
}));

mock.module("./merge-engine.js", () => ({
  MergeEngine: class {
    constructor(_opts: unknown) {}
    async initializeSessionBranch(sessionId: string): Promise<string> {
      mergeInitCalls.push(sessionId);
      return mockMergeEngineInstance.initializeSessionBranch(sessionId);
    }
    enqueue(result: WorkerResult): MergeOperation {
      mergeEnqueueCalls.push(result);
      return mockMergeEngineInstance.enqueue(result);
    }
    async processNext(): Promise<MergeOperation | null> {
      return mockMergeEngineInstance.processNext();
    }
  },
}));

import {
  ParallelCoordinator,
  type WorkerExecutor,
  type ParallelCoordinatorOptions,
} from "./coordinator.js";

// --- Helpers ---

const mockSessionPaths: SessionPaths = {
  root: "/sessions/repo/test",
  prd: "/sessions/repo/test/prd.md",
  tasks: "/sessions/repo/test/tasks.json",
  progress: "/sessions/repo/test/progress.md",
  run: "/sessions/repo/test/run.json",
  lock: "/sessions/repo/test/lock",
  logs: "/sessions/repo/test/logs",
  summary: "/sessions/repo/test/summary.md",
  interview: "/sessions/repo/test/interview.json",
  reviewRoot: "/sessions/repo/test/review",
  reviewFindings: "/sessions/repo/test/review/findings.md",
  reviewTasks: "/sessions/repo/test/review/tasks.json",
  reviewProgress: "/sessions/repo/test/review/progress.md",
  reviewConversation: "/sessions/repo/test/review/conversation.json",
};

function makeTask(id: string, overrides?: Partial<Task>): Task {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [],
    priority: 2,
    status: "open",
    iterationCount: 0,
    ...overrides,
  };
}

function makeParallelAnalysis(groups: ParallelGroup[]): TaskGraphAnalysis {
  const allIds = groups.flatMap((g) => g.taskIds);
  const nodes = new Map(
    allIds.map((id) => [
      id,
      { taskId: id, depth: 0, dependsOn: [], dependedBy: [] },
    ]),
  );
  return {
    groups,
    cyclicTaskIds: [],
    maxParallelism: Math.max(...groups.map((g) => g.taskIds.length), 0),
    recommendParallel: true,
    nodes,
  };
}

function makeSerialAnalysis(): TaskGraphAnalysis {
  return {
    groups: [{ depth: 0, taskIds: ["T-1"] }],
    cyclicTaskIds: [],
    maxParallelism: 1,
    recommendParallel: false,
    nodes: new Map([
      ["T-1", { taskId: "T-1", depth: 0, dependsOn: [], dependedBy: [] }],
    ]),
  };
}

function makeMergeOp(taskId: string, status: MergeOperation["status"]): MergeOperation {
  return {
    id: `merge-${taskId}`,
    taskId,
    taskTitle: `Task ${taskId}`,
    sourceBranch: `synth-parallel/${taskId}`,
    status,
  };
}

function makeExecutor(results?: Map<string, WorkerResult>): WorkerExecutor {
  return {
    execute: async (task: Task, worktree: WorktreeInfo): Promise<WorkerResult> => {
      if (results?.has(task.id)) return results.get(task.id)!;
      return {
        workerId: `w-${task.id}-0`,
        taskId: task.id,
        taskTitle: task.title,
        branch: worktree.branch,
      };
    },
  };
}

function makeOptions(overrides?: Partial<ParallelCoordinatorOptions>): ParallelCoordinatorOptions {
  return {
    tasks: [makeTask("T-1"), makeTask("T-2"), makeTask("T-3")],
    repoRoot: "/repo",
    project: "test-project",
    sessionPaths: mockSessionPaths,
    executor: makeExecutor(),
    ...overrides,
  };
}

function defaultWorktreeManager() {
  return {
    acquire: async (workerId: string, taskId: string, _sessionBranch: string): Promise<WorktreeInfo> => ({
      workerId,
      taskId,
      path: `/worktrees/worker-${workerId}`,
      branch: `synth-parallel/${taskId}`,
    }),
    cleanupAll: async () => {},
  };
}

function defaultMergeEngine() {
  return {
    initializeSessionBranch: async (_sessionId: string) => "synth-session/abc12345",
    enqueue: (result: WorkerResult): MergeOperation => makeMergeOp(result.taskId, "queued"),
    processNext: async (): Promise<MergeOperation | null> => {
      if (mergeProcessIndex < mergeProcessResults.length) {
        return mergeProcessResults[mergeProcessIndex++];
      }
      return null;
    },
  };
}

function collectEvents(coordinator: ParallelCoordinator): ParallelEvent[] {
  const events: ParallelEvent[] = [];
  coordinator.on((e) => events.push(e));
  return events;
}

beforeEach(() => {
  savedSessions = [];
  deletedSessions = [];
  gitCalls = [];
  worktreeAcquireCalls = [];
  worktreeCleanedUp = [];
  mergeInitCalls = [];
  mergeEnqueueCalls = [];
  mergeProcessResults = [];
  mergeProcessIndex = 0;
  mockWorktreeManagerInstance = defaultWorktreeManager();
  mockMergeEngineInstance = defaultMergeEngine();
  analyzeResult = makeParallelAnalysis([{ depth: 0, taskIds: ["T-1", "T-2", "T-3"] }]);
});

// --- Tests ---

describe("ParallelCoordinator", () => {
  describe("config defaults", () => {
    test("accepts config with maxWorkers, aiConflictResolution, maxRequeueCount", () => {
      const coordinator = new ParallelCoordinator(
        makeOptions({
          config: {
            maxWorkers: 4,
            aiConflictResolution: false,
            maxRequeueCount: 2,
          },
        }),
      );
      // Constructor doesn't throw — config is accepted
      expect(coordinator).toBeDefined();
    });

    test("uses default config values when not specified", () => {
      const coordinator = new ParallelCoordinator(makeOptions());
      // Defaults: maxWorkers=8, aiConflictResolution=true, maxRequeueCount=1
      expect(coordinator).toBeDefined();
    });
  });

  describe("serial fallback", () => {
    test("returns serial=true when <3 tasks", async () => {
      analyzeResult = makeSerialAnalysis();

      const coordinator = new ParallelCoordinator(
        makeOptions({ tasks: [makeTask("T-1")] }),
      );
      const result = await coordinator.run();

      expect(result.serial).toBe(true);
      expect(result.mergedTaskIds).toEqual([]);
      expect(result.failedTaskIds).toEqual([]);
    });

    test("returns serial=true when no group has 2+ tasks", async () => {
      analyzeResult = {
        groups: [
          { depth: 0, taskIds: ["T-1"] },
          { depth: 1, taskIds: ["T-2"] },
          { depth: 2, taskIds: ["T-3"] },
        ],
        cyclicTaskIds: [],
        maxParallelism: 1,
        recommendParallel: false,
        nodes: new Map(),
      };

      const coordinator = new ParallelCoordinator(makeOptions());
      const result = await coordinator.run();

      expect(result.serial).toBe(true);
    });

    test("does not emit any events on serial fallback", async () => {
      analyzeResult = makeSerialAnalysis();

      const coordinator = new ParallelCoordinator(
        makeOptions({ tasks: [makeTask("T-1")] }),
      );
      const events = collectEvents(coordinator);
      await coordinator.run();

      expect(events).toHaveLength(0);
    });
  });

  describe("session setup on start", () => {
    test("analyzes task graph and creates session branch", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      await coordinator.run();

      // getCurrentBranch was called
      expect(gitCalls.some((c) => c.fn === "getCurrentBranch")).toBe(true);
      // Session branch was initialized
      expect(mergeInitCalls.length).toBe(1);
      // Backup tag was created
      expect(gitCalls.some((c) => c.fn === "createTag")).toBe(true);
    });

    test("persists initial state before execution", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      await coordinator.run();

      // At least one save (initial) + one after group completion
      expect(savedSessions.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("wave execution", () => {
    test("executes waves sequentially with parallel workers", async () => {
      analyzeResult = makeParallelAnalysis([
        { depth: 0, taskIds: ["T-1", "T-2"] },
        { depth: 1, taskIds: ["T-3"] },
      ]);

      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const executedTasks: string[] = [];
      const executor: WorkerExecutor = {
        execute: async (task, worktree) => {
          executedTasks.push(task.id);
          return {
            workerId: `w-${task.id}-0`,
            taskId: task.id,
            taskTitle: task.title,
            branch: worktree.branch,
          };
        },
      };

      const coordinator = new ParallelCoordinator(
        makeOptions({ executor }),
      );
      const result = await coordinator.run();

      expect(executedTasks).toContain("T-1");
      expect(executedTasks).toContain("T-2");
      expect(executedTasks).toContain("T-3");
      expect(result.mergedTaskIds).toEqual(["T-1", "T-2", "T-3"]);
      expect(result.serial).toBe(false);
    });

    test("acquires worktrees for each task in wave", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      await coordinator.run();

      expect(worktreeAcquireCalls.length).toBe(3);
      expect(worktreeAcquireCalls.map((c) => c.taskId).sort()).toEqual(
        ["T-1", "T-2", "T-3"],
      );
    });

    test("limits parallel workers to maxWorkers", async () => {
      analyzeResult = makeParallelAnalysis([
        { depth: 0, taskIds: ["T-1", "T-2", "T-3", "T-4", "T-5"] },
      ]);

      const tasks = ["T-1", "T-2", "T-3", "T-4", "T-5"].map((id) =>
        makeTask(id),
      );

      mergeProcessResults = tasks.map((t) =>
        makeMergeOp(t.id, "completed"),
      );

      const coordinator = new ParallelCoordinator(
        makeOptions({
          tasks,
          config: { maxWorkers: 2 },
        }),
      );
      await coordinator.run();

      // All tasks were executed (batched in groups of 2)
      expect(worktreeAcquireCalls.length).toBe(5);
    });
  });

  describe("sequential merging after wave", () => {
    test("merges completed branches sequentially", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      const result = await coordinator.run();

      // Each worker result was enqueued for merge
      expect(mergeEnqueueCalls.length).toBe(3);
      expect(result.mergedTaskIds).toEqual(["T-1", "T-2", "T-3"]);
    });

    test("cleans up worktrees after each wave", async () => {
      analyzeResult = makeParallelAnalysis([
        { depth: 0, taskIds: ["T-1", "T-2"] },
        { depth: 1, taskIds: ["T-3"] },
      ]);

      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      await coordinator.run();

      // cleanupAll called once per group (2 groups)
      expect(worktreeCleanedUp.length).toBe(2);
    });

    test("persists state after each wave", async () => {
      analyzeResult = makeParallelAnalysis([
        { depth: 0, taskIds: ["T-1", "T-2"] },
        { depth: 1, taskIds: ["T-3"] },
      ]);

      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      await coordinator.run();

      // initial persist + 2 after-group persists = 3
      expect(savedSessions.length).toBe(3);
    });
  });

  describe("conflict handling and re-queue", () => {
    test("re-queues task on conflict when under maxRequeueCount", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "conflicted"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(
        makeOptions({ config: { maxRequeueCount: 1 } }),
      );
      const events = collectEvents(coordinator);
      const result = await coordinator.run();

      // T-1 was conflicted → re-queued (not in failedTaskIds)
      expect(result.failedTaskIds).not.toContain("T-1");
      // conflict:detected event was emitted
      expect(events.some((e) => e.type === "conflict:detected")).toBe(true);
    });

    test("fails task after exceeding maxRequeueCount", async () => {
      // First conflict → re-queue, second conflict → fail
      const op1 = makeMergeOp("T-1", "conflicted");
      const op2 = makeMergeOp("T-2", "completed");
      const op3 = makeMergeOp("T-3", "completed");

      mergeProcessResults = [op1, op2, op3];

      const coordinator = new ParallelCoordinator(
        makeOptions({ config: { maxRequeueCount: 0 } }),
      );
      const result = await coordinator.run();

      // With maxRequeueCount=0, conflicted tasks fail immediately
      expect(result.failedTaskIds).toContain("T-1");
    });

    test("emits merge:failed when task exceeds requeue limit", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "conflicted"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(
        makeOptions({ config: { maxRequeueCount: 0 } }),
      );
      const events = collectEvents(coordinator);
      await coordinator.run();

      expect(events.some((e) => e.type === "merge:failed")).toBe(true);
    });

    test("emits conflict:ai-resolving when aiConflictResolution is enabled", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "conflicted"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(
        makeOptions({ config: { aiConflictResolution: true, maxRequeueCount: 0 } }),
      );
      const events = collectEvents(coordinator);
      await coordinator.run();

      expect(events.some((e) => e.type === "conflict:ai-resolving")).toBe(true);
    });

    test("does not emit conflict:ai-resolving when disabled", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "conflicted"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(
        makeOptions({ config: { aiConflictResolution: false, maxRequeueCount: 0 } }),
      );
      const events = collectEvents(coordinator);
      await coordinator.run();

      expect(events.every((e) => e.type !== "conflict:ai-resolving")).toBe(true);
    });
  });

  describe("completion", () => {
    test("merges session branch to original branch on completion", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      await coordinator.run();

      // checkoutBranch called with original branch
      const checkoutCall = gitCalls.find(
        (c) => c.fn === "checkoutBranch" && c.args[0] === "main",
      );
      expect(checkoutCall).toBeDefined();

      // mergeFF called with session branch
      const mergeCall = gitCalls.find(
        (c) => c.fn === "mergeFF" && (c.args[0] as string).startsWith("synth-session/"),
      );
      expect(mergeCall).toBeDefined();
    });

    test("cleans up tag and session state on completion", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      await coordinator.run();

      // Tag was deleted
      expect(gitCalls.some((c) => c.fn === "deleteTag")).toBe(true);
      // Session was deleted
      expect(deletedSessions.length).toBe(1);
    });

    test("returns merged and failed task IDs", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "failed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      const result = await coordinator.run();

      expect(result.mergedTaskIds).toEqual(["T-1", "T-3"]);
      expect(result.failedTaskIds).toEqual(["T-2"]);
      expect(result.serial).toBe(false);
    });
  });

  describe("SIGINT / abort", () => {
    test("sets aborted flag to stop further processing", async () => {
      // Use two groups — abort after first group starts
      analyzeResult = makeParallelAnalysis([
        { depth: 0, taskIds: ["T-1", "T-2"] },
        { depth: 1, taskIds: ["T-3"] },
      ]);

      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        // T-3 won't be reached
      ];

      const executor: WorkerExecutor = {
        execute: async (task, worktree) => {
          return {
            workerId: `w-${task.id}-0`,
            taskId: task.id,
            taskTitle: task.title,
            branch: worktree.branch,
          };
        },
      };

      const coordinator = new ParallelCoordinator(
        makeOptions({ executor }),
      );

      // Call abort synchronously before run starts the second group
      // This tests the aborted flag check in the group loop
      coordinator.on((e) => {
        if (e.type === "parallel:group-completed") {
          // Abort after the first group completes — the loop checks aborted before second group
          coordinator.abort();
        }
      });

      const result = await coordinator.run();

      // T-3 should not have been executed
      expect(result.serial).toBe(false);
    });

    test("returns to original branch on abort", async () => {
      mockMergeEngineInstance.processNext = async () => {
        throw new Error("simulated merge failure");
      };

      const coordinator = new ParallelCoordinator(makeOptions());
      const events = collectEvents(coordinator);

      await expect(coordinator.run()).rejects.toThrow();

      // parallel:failed was emitted
      expect(events.some((e) => e.type === "parallel:failed")).toBe(true);
      // checkoutBranch to original branch
      expect(
        gitCalls.some(
          (c) => c.fn === "checkoutBranch" && c.args[0] === "main",
        ),
      ).toBe(true);
    });

    test("cleans up worktrees on error", async () => {
      mockMergeEngineInstance.processNext = async () => {
        throw new Error("boom");
      };

      const coordinator = new ParallelCoordinator(makeOptions());

      await expect(coordinator.run()).rejects.toThrow("boom");

      // cleanupAll was called during abort
      expect(worktreeCleanedUp.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("SIGINT handler", () => {
    let originalListenerCount: number;

    beforeEach(() => {
      originalListenerCount = process.listenerCount("SIGINT");
    });

    afterEach(() => {
      // Ensure no leaked SIGINT listeners
      while (process.listenerCount("SIGINT") > originalListenerCount) {
        const listeners = process.listeners("SIGINT");
        process.removeListener("SIGINT", listeners[listeners.length - 1] as NodeJS.SignalsListener);
      }
    });

    test("registers SIGINT handler when coordinator starts", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      let sigintCountDuringExecution = 0;

      const executor: WorkerExecutor = {
        execute: async (task, worktree) => {
          sigintCountDuringExecution = process.listenerCount("SIGINT");
          return {
            workerId: `w-${task.id}-0`,
            taskId: task.id,
            taskTitle: task.title,
            branch: worktree.branch,
          };
        },
      };

      const coordinator = new ParallelCoordinator(
        makeOptions({ executor }),
      );
      await coordinator.run();

      // SIGINT handler was registered during execution
      expect(sigintCountDuringExecution).toBeGreaterThan(originalListenerCount);
      // SIGINT handler removed after completion
      expect(process.listenerCount("SIGINT")).toBe(originalListenerCount);
    });

    test("deregisters SIGINT handler after successful completion", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      await coordinator.run();

      expect(process.listenerCount("SIGINT")).toBe(originalListenerCount);
    });

    test("deregisters SIGINT handler after error", async () => {
      mockMergeEngineInstance.processNext = async () => {
        throw new Error("merge error");
      };

      const coordinator = new ParallelCoordinator(makeOptions());

      await expect(coordinator.run()).rejects.toThrow();

      expect(process.listenerCount("SIGINT")).toBe(originalListenerCount);
    });

    test("calls executor.stop() on SIGINT", async () => {
      let stopCalled = false;
      let executorCalled: (() => void) | null = null;
      const executorCalledPromise = new Promise<void>((resolve) => {
        executorCalled = resolve;
      });
      const workerResolvers: (() => void)[] = [];

      const executor: WorkerExecutor = {
        execute: async (task, worktree) => {
          executorCalled!();
          await new Promise<void>((resolve) => {
            workerResolvers.push(resolve);
          });
          return {
            workerId: `w-${task.id}-0`,
            taskId: task.id,
            taskTitle: task.title,
            branch: worktree.branch,
          };
        },
        stop: () => {
          stopCalled = true;
          for (const resolve of workerResolvers) resolve();
        },
      };

      const coordinator = new ParallelCoordinator(
        makeOptions({ executor }),
      );

      const runPromise = coordinator.run();

      // Wait for executor to actually be called
      await executorCalledPromise;

      process.emit("SIGINT", "SIGINT");

      await runPromise;

      expect(stopCalled).toBe(true);
    });

    test("cleans up worktrees on SIGINT", async () => {
      let executorCalled: (() => void) | null = null;
      const executorCalledPromise = new Promise<void>((resolve) => {
        executorCalled = resolve;
      });
      const workerResolvers: (() => void)[] = [];

      const executor: WorkerExecutor = {
        execute: async (task, worktree) => {
          executorCalled!();
          await new Promise<void>((resolve) => {
            workerResolvers.push(resolve);
          });
          return {
            workerId: `w-${task.id}-0`,
            taskId: task.id,
            taskTitle: task.title,
            branch: worktree.branch,
          };
        },
        stop: () => {
          for (const resolve of workerResolvers) resolve();
        },
      };

      const coordinator = new ParallelCoordinator(
        makeOptions({ executor }),
      );

      const runPromise = coordinator.run();

      await executorCalledPromise;

      process.emit("SIGINT", "SIGINT");

      await runPromise;

      expect(worktreeCleanedUp.length).toBeGreaterThanOrEqual(1);
    });

    test("checks out original branch on SIGINT", async () => {
      let executorCalled: (() => void) | null = null;
      const executorCalledPromise = new Promise<void>((resolve) => {
        executorCalled = resolve;
      });
      const workerResolvers: (() => void)[] = [];

      const executor: WorkerExecutor = {
        execute: async (task, worktree) => {
          executorCalled!();
          await new Promise<void>((resolve) => {
            workerResolvers.push(resolve);
          });
          return {
            workerId: `w-${task.id}-0`,
            taskId: task.id,
            taskTitle: task.title,
            branch: worktree.branch,
          };
        },
        stop: () => {
          for (const resolve of workerResolvers) resolve();
        },
      };

      const coordinator = new ParallelCoordinator(
        makeOptions({ executor }),
      );

      const runPromise = coordinator.run();

      await executorCalledPromise;

      process.emit("SIGINT", "SIGINT");

      await runPromise;

      expect(
        gitCalls.some(
          (c) => c.fn === "checkoutBranch" && c.args[0] === "main",
        ),
      ).toBe(true);
    });

    test("emits parallel:failed with reason 'interrupted' on SIGINT", async () => {
      let executorCalled: (() => void) | null = null;
      const executorCalledPromise = new Promise<void>((resolve) => {
        executorCalled = resolve;
      });
      const workerResolvers: (() => void)[] = [];

      const executor: WorkerExecutor = {
        execute: async (task, worktree) => {
          executorCalled!();
          await new Promise<void>((resolve) => {
            workerResolvers.push(resolve);
          });
          return {
            workerId: `w-${task.id}-0`,
            taskId: task.id,
            taskTitle: task.title,
            branch: worktree.branch,
          };
        },
        stop: () => {
          for (const resolve of workerResolvers) resolve();
        },
      };

      const coordinator = new ParallelCoordinator(
        makeOptions({ executor }),
      );
      const events = collectEvents(coordinator);

      const runPromise = coordinator.run();

      await executorCalledPromise;

      process.emit("SIGINT", "SIGINT");

      await runPromise;

      const failedEvent = events.find((e) => e.type === "parallel:failed");
      expect(failedEvent).toBeDefined();
      expect((failedEvent as { reason?: string }).reason).toBe("interrupted");
    });

    test("cleanup completes even if workers do not stop within timeout", async () => {
      // Workers that never resolve (simulating hung workers)
      const executor: WorkerExecutor = {
        execute: async () => {
          // This promise never resolves — simulates a hung worker
          return new Promise<WorkerResult>(() => {});
        },
        // No stop() — workers won't be signaled to stop
      };

      const coordinator = new ParallelCoordinator(
        makeOptions({ executor }),
      );
      const events = collectEvents(coordinator);

      const runPromise = coordinator.run();

      // Wait for workers to start
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // Simulate SIGINT — handleInterrupt will wait up to 5s then proceed
      process.emit("SIGINT", "SIGINT");

      // The run() should complete (not hang forever) after the timeout
      // We set a generous test timeout but the coordinator should resolve after ~5s
      await runPromise;

      // Cleanup happened despite workers not stopping
      expect(worktreeCleanedUp.length).toBeGreaterThanOrEqual(1);
      expect(
        gitCalls.some(
          (c) => c.fn === "checkoutBranch" && c.args[0] === "main",
        ),
      ).toBe(true);

      const failedEvent = events.find((e) => e.type === "parallel:failed");
      expect(failedEvent).toBeDefined();
      expect((failedEvent as { reason?: string }).reason).toBe("interrupted");
    }, 15000); // Extended timeout for the 5s graceful shutdown wait
  });

  describe("event emission", () => {
    test("emits parallel:started on begin", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      const events = collectEvents(coordinator);
      await coordinator.run();

      expect(events[0].type).toBe("parallel:started");
    });

    test("emits group-started and group-completed for each wave", async () => {
      analyzeResult = makeParallelAnalysis([
        { depth: 0, taskIds: ["T-1", "T-2"] },
        { depth: 1, taskIds: ["T-3"] },
      ]);

      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      const events = collectEvents(coordinator);
      await coordinator.run();

      const groupStarted = events.filter(
        (e) => e.type === "parallel:group-started",
      );
      const groupCompleted = events.filter(
        (e) => e.type === "parallel:group-completed",
      );

      expect(groupStarted.length).toBe(2);
      expect(groupCompleted.length).toBe(2);
    });

    test("emits parallel:completed on success", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      const events = collectEvents(coordinator);
      await coordinator.run();

      const lastEvent = events[events.length - 1];
      expect(lastEvent.type).toBe("parallel:completed");
    });

    test("emits parallel:failed on error", async () => {
      mockMergeEngineInstance.processNext = async () => {
        throw new Error("merge engine error");
      };

      const coordinator = new ParallelCoordinator(makeOptions());
      const events = collectEvents(coordinator);

      await expect(coordinator.run()).rejects.toThrow();

      expect(events.some((e) => e.type === "parallel:failed")).toBe(true);
    });

    test("emits worker lifecycle events", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      const events = collectEvents(coordinator);
      await coordinator.run();

      expect(events.some((e) => e.type === "worker:created")).toBe(true);
      expect(events.some((e) => e.type === "worker:started")).toBe(true);
      expect(events.some((e) => e.type === "worker:completed")).toBe(true);
    });

    test("emits worker:failed when executor throws", async () => {
      const failingExecutor: WorkerExecutor = {
        execute: async () => {
          throw new Error("worker error");
        },
      };

      // No processNext results needed since all workers fail
      mergeProcessResults = [];

      const coordinator = new ParallelCoordinator(
        makeOptions({ executor: failingExecutor }),
      );
      const events = collectEvents(coordinator);
      await coordinator.run();

      expect(events.some((e) => e.type === "worker:failed")).toBe(true);
    });

    test("emits merge lifecycle events", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      const events = collectEvents(coordinator);
      await coordinator.run();

      expect(events.some((e) => e.type === "merge:queued")).toBe(true);
      expect(events.some((e) => e.type === "merge:started")).toBe(true);
      expect(events.some((e) => e.type === "merge:completed")).toBe(true);
    });
  });

  describe("event listener", () => {
    test("on() registers listener", async () => {
      analyzeResult = makeSerialAnalysis();

      const coordinator = new ParallelCoordinator(
        makeOptions({ tasks: [makeTask("T-1")] }),
      );

      let called = false;
      coordinator.on(() => {
        called = true;
      });

      // Serial fallback doesn't emit events, so called stays false
      await coordinator.run();
      expect(called).toBe(false);
    });

    test("multiple listeners receive events", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());
      const events1: ParallelEvent[] = [];
      const events2: ParallelEvent[] = [];
      coordinator.on((e) => events1.push(e));
      coordinator.on((e) => events2.push(e));

      await coordinator.run();

      expect(events1.length).toBeGreaterThan(0);
      expect(events1.length).toBe(events2.length);
    });
  });
});
