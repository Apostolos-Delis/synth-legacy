import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { PipelineEvent, PipelineOptions } from "../pipeline/types.js";
import type { AgentAdapter } from "../agents/types.js";
import type { SynthConfig } from "../config/types.js";
import type { EngineState } from "../engine/types.js";
import { makeSessionPaths, makeTask, makeTaskFile } from "./helpers.js";

// ---------------------------------------------------------------------------
// Shared mock state — reset between tests
// ---------------------------------------------------------------------------

let mockAgentDetect: () => Promise<{ available: boolean; error?: string }>;
let mockAgentDispose: ReturnType<typeof mock>;
let mockAcquireLock: ReturnType<typeof mock>;
let mockReleaseLock: ReturnType<typeof mock>;
let mockCreateRun: ReturnType<typeof mock>;
let mockEndRun: ReturnType<typeof mock>;
let mockLoadTasks: ReturnType<typeof mock>;
let mockSaveTasks: ReturnType<typeof mock>;
let mockGetProgress: ReturnType<typeof mock>;
let mockResetOrphaned: ReturnType<typeof mock>;
let mockUpdateSessionMetadata: ReturnType<typeof mock>;
let mockWriteText: ReturnType<typeof mock>;
let mockGetCurrentBranch: ReturnType<typeof mock>;
let mockCheckoutBranch: ReturnType<typeof mock>;
let mockSpawn: ReturnType<typeof mock>;
let mockEngineRun: ReturnType<typeof mock>;
let mockEngineStop: ReturnType<typeof mock>;
let mockEngineGetState: () => EngineState;
let mockEngineGetIteration: () => number;
let mockEngineOn: ReturnType<typeof mock>;
let mockCoordinatorRun: ReturnType<typeof mock>;
let mockCoordinatorAbort: ReturnType<typeof mock>;
let mockCoordinatorOn: ReturnType<typeof mock>;
let mockAnalyzeTaskGraph: ReturnType<typeof mock>;
let mockReviewOrchestratorRun: ReturnType<typeof mock>;
let mockReviewOrchestratorOn: ReturnType<typeof mock>;

function resetMocks() {
  mockAgentDetect = async () => ({ available: true, version: "1.0.0" });
  mockAgentDispose = mock(() => {});

  mockAcquireLock = mock(async () => true);
  mockReleaseLock = mock(async () => {});
  mockCreateRun = mock(async () => ({ id: "run-test-123" }));
  mockEndRun = mock(async () => {});

  mockLoadTasks = mock(async () =>
    makeTaskFile([
      makeTask({ id: "T-001", title: "Task 1", status: "open" }),
      makeTask({ id: "T-002", title: "Task 2", status: "open" }),
    ]),
  );
  mockSaveTasks = mock(async () => {});
  mockGetProgress = mock(() => ({
    total: 2,
    done: 2,
    failed: 0,
    open: 0,
    inProgress: 0,
  }));
  mockResetOrphaned = mock((tf: unknown) => tf);

  mockUpdateSessionMetadata = mock(async () => {});
  mockWriteText = mock(async () => {});
  mockGetCurrentBranch = mock(async () => "main");
  mockCheckoutBranch = mock(async () => {});

  mockSpawn = mock(() => ({
    promise: Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  }));

  mockEngineRun = mock(async () => {});
  mockEngineStop = mock(() => {});
  mockEngineGetState = () => "completed" as EngineState;
  mockEngineGetIteration = () => 2;
  mockEngineOn = mock(() => () => {});

  mockCoordinatorRun = mock(async () => ({
    mergedTaskIds: ["T-001", "T-002"],
    failedTaskIds: [],
  }));
  mockCoordinatorAbort = mock(async () => {});
  mockCoordinatorOn = mock(() => {});

  mockAnalyzeTaskGraph = mock(() => ({
    recommendParallel: true,
    groups: [["T-001"], ["T-002"]],
  }));

  mockReviewOrchestratorRun = mock(async () => ({
    findings: [],
    taskFile: null,
    executed: false,
  }));
  mockReviewOrchestratorOn = mock(() => {});
}

// ---------------------------------------------------------------------------
// Module mocks — intercept lazy dynamic imports
// ---------------------------------------------------------------------------

mock.module("../agents/registry.js", () => ({
  getAgent: (_name: string): AgentAdapter => ({
    name: "mock-agent",
    installHint: "mock",
    detect: () => mockAgentDetect(),
    execute: () => ({
      pid: 1,
      promise: Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
      interrupt: () => {},
    }),
    dispose: (...args: unknown[]) => mockAgentDispose(...args),
    checkAuth: async () => null,
  }),
}));

mock.module("../engine/engine.js", () => ({
  Engine: class MockEngine {
    on = (...args: unknown[]) => mockEngineOn(...args);
    run = (...args: unknown[]) => mockEngineRun(...args);
    stop = (...args: unknown[]) => mockEngineStop(...args);
    getState = () => mockEngineGetState();
    getIteration = () => mockEngineGetIteration();
  },
}));

mock.module("../run/run.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  acquireLock: (...args: unknown[]) => mockAcquireLock(...args),
  releaseLock: (...args: unknown[]) => mockReleaseLock(...args),
  endRun: (...args: unknown[]) => mockEndRun(...args),
}));

mock.module("../tasks/store.js", () => ({
  loadTasks: (...args: unknown[]) => mockLoadTasks(...args),
  saveTasks: (...args: unknown[]) => mockSaveTasks(...args),
  getProgress: (...args: unknown[]) => mockGetProgress(...args),
  resetOrphanedTasks: (...args: unknown[]) => mockResetOrphaned(...args),
}));

mock.module("../sessions/registry.js", () => ({
  updateSessionMetadata: (...args: unknown[]) => mockUpdateSessionMetadata(...args),
}));

mock.module("../utils/fs.js", () => ({
  writeText: (...args: unknown[]) => mockWriteText(...args),
}));

mock.module("../utils/git.js", () => ({
  getCurrentBranch: (...args: unknown[]) => mockGetCurrentBranch(...args),
  checkoutBranch: (...args: unknown[]) => mockCheckoutBranch(...args),
}));

mock.module("../utils/process.js", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

mock.module("../utils/format.js", () => ({
  formatDuration: (ms: number) => `${ms}ms`,
}));

mock.module("../logging/engine-bridge.js", () => ({
  createEngineLogBridge: () => () => {},
}));

mock.module("../logging/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

mock.module("../platform/index.js", () => ({
  getPlatform: () => ({
    inhibitSleep: () => ({ release: () => {} }),
  }),
}));

mock.module("../parallel/coordinator.js", () => ({
  ParallelCoordinator: class MockParallelCoordinator {
    on = (...args: unknown[]) => mockCoordinatorOn(...args);
    run = (...args: unknown[]) => mockCoordinatorRun(...args);
    abort = (...args: unknown[]) => mockCoordinatorAbort(...args);
  },
}));

mock.module("../parallel/task-graph.js", () => ({
  analyzeTaskGraph: (...args: unknown[]) => mockAnalyzeTaskGraph(...args),
}));

mock.module("../review/orchestrator.js", () => ({
  ReviewOrchestrator: class MockReviewOrchestrator {
    on = (...args: unknown[]) => mockReviewOrchestratorOn(...args);
    run = (...args: unknown[]) => mockReviewOrchestratorRun(...args);
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

const { ExecutionPipeline } = await import("../pipeline/execution-pipeline.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseConfig: SynthConfig = {
  project: { name: "test-project", branch: "test-branch", base_branch: "main" },
  agent: { name: "mock-agent", timeout: 30_000, skip_permissions: true },
  execution: { max_iterations: 10, iteration_delay: 0, auto_commit: false, prevent_sleep: false },
  guardrails: { max_consecutive_failures: 3, backpressure_commands: [] },
  finalize: { auto_format: false, split_commits: false, self_review: false, create_pr: false },
};

function makePipelineOptions(overrides?: Partial<PipelineOptions>): PipelineOptions {
  return {
    cwd: "/tmp/test-cwd",
    sessionId: "test-session",
    sessionPaths: makeSessionPaths("/tmp/test-session"),
    config: baseConfig,
    startIteration: 0,
    parallelMode: false,
    parallelWorkers: undefined,
    tuiEnabled: false,
    ...overrides,
  };
}

function collectEvents(pipeline: InstanceType<typeof ExecutionPipeline>): PipelineEvent[] {
  const events: PipelineEvent[] = [];
  pipeline.on((event: PipelineEvent) => events.push(event));
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExecutionPipeline", () => {
  beforeEach(() => {
    resetMocks();
  });

  // ── Successful serial run ───────────────────────────────────────────────

  describe("successful serial run", () => {
    test("emits correct phase sequence and events", async () => {
      const pipeline = new ExecutionPipeline(makePipelineOptions());
      const events = collectEvents(pipeline);

      // Auto-resolve the awaiting-action phase with quit.
      // Use setTimeout because setPhase fires before awaitAction sets actionResolve.
      pipeline.on((event: PipelineEvent) => {
        if (event.type === "phase:changed" && event.phase === "awaiting-action") {
          setTimeout(() => pipeline.submitAction({ requestId: "auto", key: "quit" }), 0);
        }
      });

      await pipeline.run();

      const phases = events
        .filter((e): e is Extract<PipelineEvent, { type: "phase:changed" }> => e.type === "phase:changed")
        .map((e) => e.phase);

      expect(phases).toEqual([
        "initializing",
        "executing",
        "reviewing",
        "summarizing",
        "awaiting-action",
        "done",
      ]);

      // Execution completed event was emitted
      const execCompleted = events.find(
        (e): e is Extract<PipelineEvent, { type: "execution:completed" }> => e.type === "execution:completed",
      );
      expect(execCompleted).toBeDefined();
      expect(execCompleted!.success).toBe(true);

      // Engine was used (serial)
      expect(mockEngineRun).toHaveBeenCalled();

      // Lock was acquired and released
      expect(mockAcquireLock).toHaveBeenCalled();
      expect(mockReleaseLock).toHaveBeenCalled();

      // Final state is done
      const state = pipeline.getState();
      expect(state.phase).toBe("done");
    });
  });

  // ── Successful parallel run ─────────────────────────────────────────────

  describe("successful parallel run", () => {
    test("emits correct event sequence with parallel coordinator", async () => {
      // Need 3+ actionable tasks for parallel mode
      mockLoadTasks = mock(async () =>
        makeTaskFile([
          makeTask({ id: "T-001", title: "Task 1", status: "open" }),
          makeTask({ id: "T-002", title: "Task 2", status: "open" }),
          makeTask({ id: "T-003", title: "Task 3", status: "open" }),
        ]),
      );

      mockCoordinatorRun = mock(async () => ({
        mergedTaskIds: ["T-001", "T-002", "T-003"],
        failedTaskIds: [],
      }));

      const pipeline = new ExecutionPipeline(
        makePipelineOptions({ parallelMode: true }),
      );
      const events = collectEvents(pipeline);

      pipeline.on((event: PipelineEvent) => {
        if (event.type === "phase:changed" && event.phase === "awaiting-action") {
          setTimeout(() => pipeline.submitAction({ requestId: "auto", key: "quit" }), 0);
        }
      });

      await pipeline.run();

      const phases = events
        .filter((e): e is Extract<PipelineEvent, { type: "phase:changed" }> => e.type === "phase:changed")
        .map((e) => e.phase);

      expect(phases).toEqual([
        "initializing",
        "executing",
        "reviewing",
        "summarizing",
        "awaiting-action",
        "done",
      ]);

      // Coordinator was used, not serial engine
      expect(mockCoordinatorRun).toHaveBeenCalled();
      expect(mockEngineRun).not.toHaveBeenCalled();

      // Execution completed successfully
      const execCompleted = events.find(
        (e): e is Extract<PipelineEvent, { type: "execution:completed" }> => e.type === "execution:completed",
      );
      expect(execCompleted).toBeDefined();
      expect(execCompleted!.success).toBe(true);
    });

    test("falls back to serial when parallel not recommended", async () => {
      mockAnalyzeTaskGraph = mock(() => ({
        recommendParallel: false,
        groups: [],
      }));

      const pipeline = new ExecutionPipeline(
        makePipelineOptions({ parallelMode: true }),
      );
      const events = collectEvents(pipeline);

      pipeline.on((event: PipelineEvent) => {
        if (event.type === "phase:changed" && event.phase === "awaiting-action") {
          setTimeout(() => pipeline.submitAction({ requestId: "auto", key: "quit" }), 0);
        }
      });

      await pipeline.run();

      // Fell back to serial engine
      expect(mockEngineRun).toHaveBeenCalled();
      expect(mockCoordinatorRun).not.toHaveBeenCalled();

      const execCompleted = events.find(
        (e): e is Extract<PipelineEvent, { type: "execution:completed" }> => e.type === "execution:completed",
      );
      expect(execCompleted!.success).toBe(true);
    });
  });

  // ── Lock acquisition failure ────────────────────────────────────────────

  describe("lock acquisition failure", () => {
    test("emits error event and transitions to failed phase", async () => {
      mockAcquireLock = mock(async () => false);

      const pipeline = new ExecutionPipeline(makePipelineOptions());
      const events = collectEvents(pipeline);

      await pipeline.run();

      // Should have an error event
      const errorEvent = events.find(
        (e): e is Extract<PipelineEvent, { type: "error" }> => e.type === "error",
      );
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.error.message).toContain("Another synth instance");

      // Should reach failed phase
      const phases = events
        .filter((e): e is Extract<PipelineEvent, { type: "phase:changed" }> => e.type === "phase:changed")
        .map((e) => e.phase);

      expect(phases).toContain("failed");

      // Final state
      const state = pipeline.getState();
      expect(state.phase).toBe("failed");
    });
  });

  // ── Agent not available ─────────────────────────────────────────────────

  describe("agent not available", () => {
    test("emits error event and transitions to failed phase", async () => {
      mockAgentDetect = async () => ({
        available: false,
        error: "claude not found in PATH",
      });

      const pipeline = new ExecutionPipeline(makePipelineOptions());
      const events = collectEvents(pipeline);

      await pipeline.run();

      const errorEvent = events.find(
        (e): e is Extract<PipelineEvent, { type: "error" }> => e.type === "error",
      );
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.error.message).toContain("not available");
      expect(errorEvent!.error.message).toContain("claude not found in PATH");

      const phases = events
        .filter((e): e is Extract<PipelineEvent, { type: "phase:changed" }> => e.type === "phase:changed")
        .map((e) => e.phase);

      expect(phases).toContain("failed");

      const state = pipeline.getState();
      expect(state.phase).toBe("failed");
    });
  });

  // ── No actionable tasks ─────────────────────────────────────────────────

  describe("no actionable tasks", () => {
    test("skips execution phase and goes to summarizing", async () => {
      mockLoadTasks = mock(async () =>
        makeTaskFile([
          makeTask({ id: "T-001", title: "Task 1", status: "done" }),
          makeTask({ id: "T-002", title: "Task 2", status: "done" }),
        ]),
      );

      const pipeline = new ExecutionPipeline(makePipelineOptions());
      const events = collectEvents(pipeline);

      pipeline.on((event: PipelineEvent) => {
        if (event.type === "phase:changed" && event.phase === "awaiting-action") {
          setTimeout(() => pipeline.submitAction({ requestId: "auto", key: "quit" }), 0);
        }
      });

      await pipeline.run();

      const phases = events
        .filter((e): e is Extract<PipelineEvent, { type: "phase:changed" }> => e.type === "phase:changed")
        .map((e) => e.phase);

      // Execution phase should NOT appear — skipped
      expect(phases).not.toContain("executing");

      // Should still reach reviewing, summarizing, done
      expect(phases).toContain("reviewing");
      expect(phases).toContain("summarizing");
      expect(phases).toContain("done");

      // Engine was never run
      expect(mockEngineRun).not.toHaveBeenCalled();

      // Log about skipping
      const skipLog = events.find(
        (e): e is Extract<PipelineEvent, { type: "log" }> =>
          e.type === "log" && e.message.includes("No actionable tasks"),
      );
      expect(skipLog).toBeDefined();

      // execution:completed still emitted with success=true
      const execCompleted = events.find(
        (e): e is Extract<PipelineEvent, { type: "execution:completed" }> => e.type === "execution:completed",
      );
      expect(execCompleted).toBeDefined();
      expect(execCompleted!.success).toBe(true);
    });
  });

  // ── Engine error during execution ───────────────────────────────────────

  describe("engine error during execution", () => {
    test("catches error, emits error event, and cleanup runs", async () => {
      mockEngineRun = mock(async () => {
        throw new Error("Agent process crashed");
      });

      const pipeline = new ExecutionPipeline(makePipelineOptions());
      const events = collectEvents(pipeline);

      await pipeline.run();

      // Error event was emitted
      const errorEvent = events.find(
        (e): e is Extract<PipelineEvent, { type: "error" }> => e.type === "error",
      );
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.error.message).toBe("Agent process crashed");
      expect(errorEvent!.phase).toBe("executing");

      // Pipeline reached failed phase
      const phases = events
        .filter((e): e is Extract<PipelineEvent, { type: "phase:changed" }> => e.type === "phase:changed")
        .map((e) => e.phase);
      expect(phases).toContain("failed");

      // Cleanup ran — lock released, agent disposed
      expect(mockReleaseLock).toHaveBeenCalled();
      expect(mockAgentDispose).toHaveBeenCalled();

      // endRun called with "failed"
      expect(mockEndRun).toHaveBeenCalledWith(
        expect.anything(),
        "failed",
      );
    });
  });

  // ── Stop / cleanup ──────────────────────────────────────────────────────

  describe("stop and cleanup", () => {
    test("stop triggers engine stop, lock release, and agent disposal", async () => {
      // Make engine run block until resolved externally.
      // Use a promise that the test controls to coordinate stop timing.
      let resolveEngineRun: (() => void) | null = null;
      const engineRunCalled = new Promise<void>((resolve) => {
        mockEngineRun = mock(
          () =>
            new Promise<void>((engineResolve) => {
              resolveEngineRun = engineResolve;
              resolve(); // Signal that engine.run() has been entered
            }),
        );
      });

      // When stopped, engine returns "paused"
      mockEngineGetState = () => "paused" as EngineState;

      const pipeline = new ExecutionPipeline(makePipelineOptions());
      const events = collectEvents(pipeline);

      // Start the pipeline run (do not await)
      const runPromise = pipeline.run();

      // Wait until engine.run() is actually called and blocking
      await engineRunCalled;

      // Trigger stop and unblock engine
      pipeline.stop();
      resolveEngineRun!();

      await runPromise;

      // Engine stop was called
      expect(mockEngineStop).toHaveBeenCalled();

      // Lock was released during cleanup
      expect(mockReleaseLock).toHaveBeenCalled();

      // Agent was disposed during cleanup
      expect(mockAgentDispose).toHaveBeenCalled();

      // Pipeline ended at done (interrupted path)
      const phases = events
        .filter((e): e is Extract<PipelineEvent, { type: "phase:changed" }> => e.type === "phase:changed")
        .map((e) => e.phase);
      expect(phases).toContain("done");
    });
  });
});
