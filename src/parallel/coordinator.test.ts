import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Task } from "../tasks/types.js";
import type { SessionPaths } from "../sessions/types.js";
import type { SynthConfig } from "../config/types.js";
import type { AgentAdapter } from "../agents/types.js";
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

// Worker mock state
let workerStartedTasks: string[] = [];
let workerStopCalled: string[] = [];
type WorkerStartBehavior = "immediate" | "hang" | "hang-forever" | "throw";
let workerStartBehavior: WorkerStartBehavior = "immediate";
let workerHangResolvers: Map<string, (result: WorkerResult) => void> = new Map();

// Conflict resolver mock state
let conflictResolverResult: { resolved: boolean; resolvedCount: number; failedCount: number } = {
  resolved: false,
  resolvedCount: 0,
  failedCount: 0,
};

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
  cleanupStaleParallelState: async () => {},
  reconcileTasksFromGitLog: async () => [],
}));

mock.module("./conflict-resolver.js", () => ({
  resolveConflicts: async () => conflictResolverResult,
}));

mock.module("./resource-monitor.js", () => ({
  ResourceMonitor: class {
    snapshot() {
      return { loadAvg1m: 1.0, cpuCount: 8, freeMemPct: 50, processRssMb: 200 };
    }
    recommendedConcurrency(maxDesired: number) {
      return { concurrency: maxDesired, reason: null };
    }
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
  listBranches: async () => [],
  listTags: async () => [],
  gitLog: async () => "",
}));

mock.module("../utils/fs.js", () => ({
  fileExists: async () => false,
  readText: async () => "",
}));

mock.module("../tasks/store.js", () => ({
  loadTasks: async () => ({ tasks: [] }),
  saveTasks: async () => {},
  updateTaskStatus: (taskFile: unknown) => taskFile,
}));

// Mock WorktreeManager and MergeEngine as classes
let mockWorktreeManagerInstance: {
  acquire: (workerId: string, taskId: string, sessionBranch: string) => Promise<WorktreeInfo>;
  cleanupAll: () => Promise<void>;
  releaseDirectory: (workerId: string) => Promise<void>;
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
    async releaseDirectory(workerId: string): Promise<void> {
      return mockWorktreeManagerInstance.releaseDirectory(workerId);
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

// Mock Worker class — replaces the real Engine-wrapping Worker with a controllable test double
mock.module("./worker.js", () => ({
  Worker: class {
    readonly id: string;
    readonly config: { id: string; task: Task; worktreePath: string; branchName: string };

    constructor(
      config: { id: string; task: Task; worktreePath: string; branchName: string },
      _synthConfig: SynthConfig,
      _agent: AgentAdapter,
      _fallbackAgent: AgentAdapter | null,
      _sessionPaths: SessionPaths,
    ) {
      this.id = config.id;
      this.config = config;
    }

    on() {
      return () => {};
    }

    onEngineEvent() {
      return () => {};
    }

    async start(): Promise<WorkerResult> {
      workerStartedTasks.push(this.config.task.id);

      if (workerStartBehavior === "throw") {
        throw new Error("worker error");
      }

      if (workerStartBehavior === "hang-forever") {
        return new Promise<WorkerResult>(() => {});
      }

      if (workerStartBehavior === "hang") {
        return new Promise<WorkerResult>((resolve) => {
          workerHangResolvers.set(this.id, resolve);
        });
      }

      return {
        workerId: this.id,
        taskId: this.config.task.id,
        taskTitle: this.config.task.title,
        branch: this.config.branchName,
        success: true,
        iterationsRun: 1,
        durationMs: 100,
        commitCount: 1,
        worktreePath: this.config.worktreePath,
      };
    }

    stop() {
      workerStopCalled.push(this.id);
      const resolver = workerHangResolvers.get(this.id);
      if (resolver) {
        resolver({
          workerId: this.id,
          taskId: this.config.task.id,
          taskTitle: this.config.task.title,
          branch: this.config.branchName,
          success: false,
          iterationsRun: 0,
          durationMs: 0,
          commitCount: 0,
          worktreePath: this.config.worktreePath,
          error: "Worker was cancelled",
        });
        workerHangResolvers.delete(this.id);
      }
    }

    getDisplayState() {
      return {
        id: this.id,
        status: "idle" as const,
        task: this.config.task,
        currentIteration: 0,
        maxIterations: 10,
        lastOutput: "",
        elapsedMs: 0,
        worktreePath: this.config.worktreePath,
        branchName: this.config.branchName,
      };
    }

    getStatus() {
      return "idle";
    }

    getTask() {
      return this.config.task;
    }
  },
}));

import {
  ParallelCoordinator,
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

const mockSynthConfig: SynthConfig = {
  project: { name: "test-project", branch: "main", base_branch: "main" },
  agent: { name: "claude", timeout: 30000, skip_permissions: true },
  execution: { max_iterations: 10, iteration_delay: 0, auto_commit: true },
  guardrails: { max_consecutive_failures: 3, backpressure_commands: [] },
  finalize: { auto_format: false, split_commits: false, self_review: false, create_pr: false },
};

const mockAgent: AgentAdapter = {
  name: "mock",
  detect: async () => ({ available: true }),
  execute: () => ({
    pid: 0,
    promise: Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    interrupt: () => {},
  }),
  dispose: () => {},
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

function makeOptions(overrides?: Partial<ParallelCoordinatorOptions>): ParallelCoordinatorOptions {
  return {
    tasks: [makeTask("T-1"), makeTask("T-2"), makeTask("T-3")],
    repoRoot: "/repo",
    project: "test-project",
    sessionPaths: mockSessionPaths,
    config: { staggerDelayMs: 0 },
    synthConfig: mockSynthConfig,
    agent: mockAgent,
    fallbackAgent: null,
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
    releaseDirectory: async () => {},
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
  workerStartedTasks = [];
  workerStopCalled = [];
  workerStartBehavior = "immediate";
  workerHangResolvers = new Map();
  conflictResolverResult = { resolved: false, resolvedCount: 0, failedCount: 0 };
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
      expect(coordinator).toBeDefined();
    });

    test("uses default config values when not specified", () => {
      const coordinator = new ParallelCoordinator(makeOptions());
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

      expect(gitCalls.some((c) => c.fn === "getCurrentBranch")).toBe(true);
      expect(mergeInitCalls.length).toBe(1);
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

      const coordinator = new ParallelCoordinator(makeOptions());
      const result = await coordinator.run();

      expect(workerStartedTasks).toContain("T-1");
      expect(workerStartedTasks).toContain("T-2");
      expect(workerStartedTasks).toContain("T-3");
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
          config: { maxWorkers: 2, staggerDelayMs: 0 },
        }),
      );
      await coordinator.run();

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
        makeOptions({ config: { maxRequeueCount: 1, staggerDelayMs: 0 } }),
      );
      const events = collectEvents(coordinator);
      const result = await coordinator.run();

      expect(result.failedTaskIds).not.toContain("T-1");
      expect(events.some((e) => e.type === "conflict:detected")).toBe(true);
    });

    test("fails task after exceeding maxRequeueCount", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "conflicted"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(
        makeOptions({ config: { maxRequeueCount: 0, staggerDelayMs: 0 } }),
      );
      const result = await coordinator.run();

      expect(result.failedTaskIds).toContain("T-1");
    });

    test("emits merge:failed when task exceeds requeue limit", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "conflicted"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(
        makeOptions({ config: { maxRequeueCount: 0, staggerDelayMs: 0 } }),
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
        makeOptions({ config: { aiConflictResolution: true, maxRequeueCount: 0, staggerDelayMs: 0 } }),
      );
      const events = collectEvents(coordinator);
      await coordinator.run();

      expect(events.some((e) => e.type === "conflict:ai-resolving")).toBe(true);
    });

    test("re-queued tasks are re-executed in a new wave", async () => {
      // First wave: T-1 conflicts, T-2 and T-3 complete
      // Re-queue wave: T-1 succeeds on second attempt
      mergeProcessResults = [
        makeMergeOp("T-1", "conflicted"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
        makeMergeOp("T-1", "completed"), // T-1 succeeds on re-queue
      ];

      const coordinator = new ParallelCoordinator(
        makeOptions({ config: { maxRequeueCount: 1, staggerDelayMs: 0 } }),
      );
      const events = collectEvents(coordinator);
      const result = await coordinator.run();

      // T-1 should have been executed twice (original + re-queue)
      const t1Executions = workerStartedTasks.filter((id) => id === "T-1");
      expect(t1Executions.length).toBe(2);

      // T-1 should be in mergedTaskIds (succeeded on re-queue), not in failedTaskIds
      expect(result.mergedTaskIds).toContain("T-1");
      expect(result.failedTaskIds).not.toContain("T-1");

      // Should have emitted task:requeued event
      expect(events.some((e) => e.type === "task:requeued")).toBe(true);

      // Should have extra group events for the re-queue wave
      const groupStarted = events.filter((e) => e.type === "parallel:group-started");
      expect(groupStarted.length).toBe(2); // original wave + re-queue wave
    });

    test("re-queued tasks injected into next group when available", async () => {
      analyzeResult = makeParallelAnalysis([
        { depth: 0, taskIds: ["T-1", "T-2"] },
        { depth: 1, taskIds: ["T-3"] },
      ]);

      // First wave: T-1 conflicts, T-2 completes
      // Second wave (with re-queued T-1 prepended): T-1 succeeds, T-3 completes
      mergeProcessResults = [
        makeMergeOp("T-1", "conflicted"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-1", "completed"), // T-1 succeeds on re-queue in group 2
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(
        makeOptions({ config: { maxRequeueCount: 1, staggerDelayMs: 0 } }),
      );
      const result = await coordinator.run();

      // T-1 should have been executed twice
      const t1Executions = workerStartedTasks.filter((id) => id === "T-1");
      expect(t1Executions.length).toBe(2);

      // All tasks should be merged
      expect(result.mergedTaskIds).toContain("T-1");
      expect(result.mergedTaskIds).toContain("T-2");
      expect(result.mergedTaskIds).toContain("T-3");
      expect(result.failedTaskIds).toHaveLength(0);
    });

    test("re-queued task fails after exhausting requeue attempts", async () => {
      // Single wave: T-1 conflicts twice (once original, once re-queue)
      mergeProcessResults = [
        makeMergeOp("T-1", "conflicted"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
        makeMergeOp("T-1", "conflicted"), // T-1 conflicts again on re-queue
      ];

      const coordinator = new ParallelCoordinator(
        makeOptions({ config: { maxRequeueCount: 1, staggerDelayMs: 0 } }),
      );
      const result = await coordinator.run();

      // T-1 should have been executed twice
      const t1Executions = workerStartedTasks.filter((id) => id === "T-1");
      expect(t1Executions.length).toBe(2);

      // T-1 should be in failedTaskIds after exhausting retries
      expect(result.failedTaskIds).toContain("T-1");
      expect(result.mergedTaskIds).not.toContain("T-1");
    });

    test("does not emit conflict:ai-resolving when disabled", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "conflicted"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(
        makeOptions({ config: { aiConflictResolution: false, maxRequeueCount: 0, staggerDelayMs: 0 } }),
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

      const checkoutCall = gitCalls.find(
        (c) => c.fn === "checkoutBranch" && c.args[0] === "main",
      );
      expect(checkoutCall).toBeDefined();

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

      expect(gitCalls.some((c) => c.fn === "deleteTag")).toBe(true);
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
      analyzeResult = makeParallelAnalysis([
        { depth: 0, taskIds: ["T-1", "T-2"] },
        { depth: 1, taskIds: ["T-3"] },
      ]);

      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());

      coordinator.on((e) => {
        if (e.type === "parallel:group-completed") {
          coordinator.abort();
        }
      });

      const result = await coordinator.run();

      expect(result.serial).toBe(false);
    });

    test("returns to original branch on abort", async () => {
      mockMergeEngineInstance.processNext = async () => {
        throw new Error("simulated merge failure");
      };

      const coordinator = new ParallelCoordinator(makeOptions());
      const events = collectEvents(coordinator);

      await expect(coordinator.run()).rejects.toThrow();

      expect(events.some((e) => e.type === "parallel:failed")).toBe(true);
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

      expect(worktreeCleanedUp.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("SIGINT handler", () => {
    let originalListenerCount: number;

    beforeEach(() => {
      originalListenerCount = process.listenerCount("SIGINT");
    });

    afterEach(() => {
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

      const coordinator = new ParallelCoordinator(makeOptions());

      let sigintCountDuringExecution = 0;
      coordinator.on((e) => {
        if (e.type === "worker:created") {
          sigintCountDuringExecution = process.listenerCount("SIGINT");
        }
      });

      await coordinator.run();

      expect(sigintCountDuringExecution).toBeGreaterThan(originalListenerCount);
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

    test("calls worker.stop() on SIGINT", async () => {
      workerStartBehavior = "hang";

      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(makeOptions());

      const runPromise = coordinator.run();

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      process.emit("SIGINT", "SIGINT");

      await runPromise;

      expect(workerStopCalled.length).toBeGreaterThan(0);
    });

    test("cleans up worktrees on SIGINT", async () => {
      workerStartBehavior = "hang";

      mergeProcessResults = [];

      const coordinator = new ParallelCoordinator(makeOptions());

      const runPromise = coordinator.run();

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      process.emit("SIGINT", "SIGINT");

      await runPromise;

      expect(worktreeCleanedUp.length).toBeGreaterThanOrEqual(1);
    });

    test("checks out original branch on SIGINT", async () => {
      workerStartBehavior = "hang";

      mergeProcessResults = [];

      const coordinator = new ParallelCoordinator(makeOptions());

      const runPromise = coordinator.run();

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      process.emit("SIGINT", "SIGINT");

      await runPromise;

      expect(
        gitCalls.some(
          (c) => c.fn === "checkoutBranch" && c.args[0] === "main",
        ),
      ).toBe(true);
    });

    test("emits parallel:failed with reason 'interrupted' on SIGINT", async () => {
      workerStartBehavior = "hang";

      mergeProcessResults = [];

      const coordinator = new ParallelCoordinator(makeOptions());
      const events = collectEvents(coordinator);

      const runPromise = coordinator.run();

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      process.emit("SIGINT", "SIGINT");

      await runPromise;

      const failedEvent = events.find((e) => e.type === "parallel:failed");
      expect(failedEvent).toBeDefined();
      expect((failedEvent as { reason?: string }).reason).toBe("interrupted");
    });

    test("cleanup completes even if workers do not stop within timeout", async () => {
      workerStartBehavior = "hang-forever";

      const coordinator = new ParallelCoordinator(makeOptions());
      const events = collectEvents(coordinator);

      const runPromise = coordinator.run();

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      process.emit("SIGINT", "SIGINT");

      await runPromise;

      expect(worktreeCleanedUp.length).toBeGreaterThanOrEqual(1);
      expect(
        gitCalls.some(
          (c) => c.fn === "checkoutBranch" && c.args[0] === "main",
        ),
      ).toBe(true);

      const failedEvent = events.find((e) => e.type === "parallel:failed");
      expect(failedEvent).toBeDefined();
      expect((failedEvent as { reason?: string }).reason).toBe("interrupted");
    }, 15000);
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
      expect(events.some((e) => e.type === "worker:completed")).toBe(true);
    });

    test("emits worker:failed when worker throws", async () => {
      workerStartBehavior = "throw";

      mergeProcessResults = [];

      const coordinator = new ParallelCoordinator(makeOptions());
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

  describe("staggered launch", () => {
    test("accepts staggerDelayMs config", () => {
      const coordinator = new ParallelCoordinator(
        makeOptions({
          config: { staggerDelayMs: 500 },
        }),
      );
      expect(coordinator).toBeDefined();
    });

    test("defaults staggerDelayMs to 2000 when not specified", () => {
      const coordinator = new ParallelCoordinator(makeOptions());
      expect(coordinator).toBeDefined();
    });

    test("launches workers with stagger delay between them", async () => {
      mergeProcessResults = [
        makeMergeOp("T-1", "completed"),
        makeMergeOp("T-2", "completed"),
        makeMergeOp("T-3", "completed"),
      ];

      const coordinator = new ParallelCoordinator(
        makeOptions({
          config: { staggerDelayMs: 0 },
        }),
      );
      const result = await coordinator.run();

      expect(workerStartedTasks).toContain("T-1");
      expect(workerStartedTasks).toContain("T-2");
      expect(workerStartedTasks).toContain("T-3");
      expect(result.mergedTaskIds).toEqual(["T-1", "T-2", "T-3"]);
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
