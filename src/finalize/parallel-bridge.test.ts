import { describe, test, expect } from "bun:test";
import {
  createInitialTuiState,
  applyParallelEvent,
  buildWorkerInfos,
  type ParallelTuiState,
} from "./parallel-bridge.js";
import type { ParallelEvent } from "../parallel/events.js";
import type { WorkerDisplayState } from "../parallel/worker.js";

function makeWorkerState(overrides: Partial<WorkerDisplayState> = {}): WorkerDisplayState {
  return {
    id: "w1",
    status: "running",
    task: {
      id: "FIX-001",
      title: "Fix something",
      description: "",
      acceptanceCriteria: [],
      priority: 3,
      status: "open",
      iterationCount: 1,
    },
    currentIteration: 1,
    maxIterations: 3,
    lastOutput: "some output",
    elapsedMs: 5000,
    worktreePath: "/tmp/wt1",
    branchName: "fix/FIX-001",
    ...overrides,
  };
}

describe("createInitialTuiState", () => {
  test("creates state with correct totalTasks", () => {
    const state = createInitialTuiState(5);

    expect(state.header.totalTasks).toBe(5);
    expect(state.header.currentWave).toBe(0);
    expect(state.header.activeWorkers).toBe(0);
    expect(state.header.mergedTasks).toBe(0);
    expect(state.workers).toEqual([]);
    expect(state.mergeItems).toEqual([]);
    expect(state.conflict).toBeNull();
  });
});

describe("buildWorkerInfos", () => {
  test("maps WorkerDisplayState to WorkerInfo", () => {
    const states = [makeWorkerState()];
    const infos = buildWorkerInfos(states);

    expect(infos).toHaveLength(1);
    expect(infos[0].id).toBe("w1");
    expect(infos[0].taskId).toBe("FIX-001");
    expect(infos[0].taskTitle).toBe("Fix something");
    expect(infos[0].iteration).toBe(1);
    expect(infos[0].maxIterations).toBe(3);
    expect(infos[0].status).toBe("running");
    expect(infos[0].lastOutput).toBe("some output");
    expect(infos[0].branchName).toBe("fix/FIX-001");
  });

  test("maps completed status", () => {
    const infos = buildWorkerInfos([makeWorkerState({ status: "completed" })]);
    expect(infos[0].status).toBe("completed");
  });

  test("maps failed/cancelled to failed", () => {
    expect(buildWorkerInfos([makeWorkerState({ status: "failed" })])[0].status).toBe("failed");
    expect(buildWorkerInfos([makeWorkerState({ status: "cancelled" })])[0].status).toBe("failed");
  });
});

describe("applyParallelEvent", () => {
  let state: ParallelTuiState;

  function apply(event: ParallelEvent, getStates?: () => WorkerDisplayState[]): boolean {
    return applyParallelEvent(event, state, getStates);
  }

  function ts(): string {
    return new Date().toISOString();
  }

  test("parallel:started returns true", () => {
    state = createInitialTuiState(3);
    expect(apply({ type: "parallel:started", timestamp: ts() })).toBe(true);
  });

  test("parallel:started with totalGroups sets totalWaves", () => {
    state = createInitialTuiState(3);
    apply({ type: "parallel:started", timestamp: ts(), totalGroups: 4 });
    expect(state.header.totalWaves).toBe(4);
  });

  test("parallel:started without totalGroups keeps default totalWaves", () => {
    state = createInitialTuiState(3);
    apply({ type: "parallel:started", timestamp: ts() });
    expect(state.header.totalWaves).toBe(1);
  });

  test("parallel:group-started increments wave", () => {
    state = createInitialTuiState(3);
    apply({ type: "parallel:group-started", timestamp: ts() });

    expect(state.header.currentWave).toBe(1);
  });

  test("worker:started updates workers and active count", () => {
    state = createInitialTuiState(3);
    const getStates = () => [makeWorkerState()];
    apply({ type: "worker:started", timestamp: ts(), workerId: "w1" }, getStates);

    expect(state.workers).toHaveLength(1);
    expect(state.header.activeWorkers).toBe(1);
  });

  test("worker:completed updates active count", () => {
    state = createInitialTuiState(3);
    const getStates = () => [makeWorkerState({ status: "completed" })];
    apply({ type: "worker:completed", timestamp: ts(), workerId: "w1" }, getStates);

    expect(state.header.activeWorkers).toBe(0);
  });

  test("worker:progress recalculates activeWorkers", () => {
    state = createInitialTuiState(3);
    const w1Running = makeWorkerState({ id: "w1", status: "running" });
    const w2Running = makeWorkerState({ id: "w2", status: "running" });
    apply({ type: "worker:started", timestamp: ts(), workerId: "w1" }, () => [w1Running, w2Running]);
    expect(state.header.activeWorkers).toBe(2);

    apply({ type: "worker:progress", timestamp: ts(), workerId: "w1", iteration: 2, maxIterations: 3, elapsedMs: 1000, status: "running" }, () => [w1Running, w2Running]);
    expect(state.header.activeWorkers).toBe(2);
  });

  test("worker:output recalculates activeWorkers", () => {
    state = createInitialTuiState(3);
    const w1Running = makeWorkerState({ id: "w1", status: "running" });
    apply({ type: "worker:started", timestamp: ts(), workerId: "w1" }, () => [w1Running]);
    expect(state.header.activeWorkers).toBe(1);

    apply({ type: "worker:output", timestamp: ts(), workerId: "w1", message: "doing stuff", taskId: "FIX-001" }, () => [w1Running]);
    expect(state.header.activeWorkers).toBe(1);
  });

  test("merge:queued adds item", () => {
    state = createInitialTuiState(3);
    apply({ type: "merge:queued", timestamp: ts(), operationId: "m1", taskId: "FIX-001" });

    expect(state.mergeItems).toHaveLength(1);
    expect(state.mergeItems[0].id).toBe("m1");
    expect(state.mergeItems[0].status).toBe("queued");
  });

  test("merge:started transitions to in-progress", () => {
    state = createInitialTuiState(3);
    apply({ type: "merge:queued", timestamp: ts(), operationId: "m1", taskId: "FIX-001" });
    apply({ type: "merge:started", timestamp: ts(), operationId: "m1", taskId: "FIX-001" });

    expect(state.mergeItems[0].status).toBe("in-progress");
    expect(state.mergeItems[0].startTime).toBeDefined();
  });

  test("merge:completed updates merged count", () => {
    state = createInitialTuiState(3);
    apply({ type: "merge:queued", timestamp: ts(), operationId: "m1", taskId: "FIX-001" });
    apply({ type: "merge:completed", timestamp: ts(), operationId: "m1", taskId: "FIX-001" });

    expect(state.mergeItems[0].status).toBe("completed");
    expect(state.header.mergedTasks).toBe(1);
  });

  test("merge:failed sets failed status", () => {
    state = createInitialTuiState(3);
    apply({ type: "merge:queued", timestamp: ts(), operationId: "m1", taskId: "FIX-001" });
    apply({ type: "merge:failed", timestamp: ts(), operationId: "m1", taskId: "FIX-001" });

    expect(state.mergeItems[0].status).toBe("failed");
  });

  test("conflict:detected sets conflict info", () => {
    state = createInitialTuiState(3);
    apply({
      type: "conflict:detected",
      timestamp: ts(),
      taskId: "FIX-001",
      taskTitle: "Fix something",
      files: ["src/a.ts", "src/b.ts"],
    });

    expect(state.conflict).not.toBeNull();
    expect(state.conflict!.taskId).toBe("FIX-001");
    expect(state.conflict!.files).toHaveLength(2);
    expect(state.conflict!.files[0].status).toBe("pending");
  });

  test("conflict:ai-resolving updates file status", () => {
    state = createInitialTuiState(3);
    apply({
      type: "conflict:detected",
      timestamp: ts(),
      taskId: "FIX-001",
      taskTitle: "Fix something",
      files: ["src/a.ts"],
    });
    apply({
      type: "conflict:ai-resolving",
      timestamp: ts(),
      taskId: "FIX-001",
      filePath: "src/a.ts",
    });

    expect(state.conflict!.files[0].status).toBe("ai-resolving");
  });

  test("conflict:resolved clears conflict", () => {
    state = createInitialTuiState(3);
    apply({
      type: "conflict:detected",
      timestamp: ts(),
      taskId: "FIX-001",
      taskTitle: "Fix something",
      files: ["src/a.ts"],
    });
    apply({
      type: "conflict:resolved",
      timestamp: ts(),
      taskId: "FIX-001",
      resolvedCount: 1,
      failedCount: 0,
    });

    expect(state.conflict).toBeNull();
  });

  test("parallel:completed zeroes active workers", () => {
    state = createInitialTuiState(3);
    state.header.activeWorkers = 2;
    apply({ type: "parallel:completed", timestamp: ts() });

    expect(state.header.activeWorkers).toBe(0);
  });

  test("unknown event returns false", () => {
    state = createInitialTuiState(3);
    const result = apply({ type: "task:requeued", timestamp: ts(), taskId: "FIX-001", attempt: 1, maxAttempts: 3 });
    expect(result).toBe(false);
  });

  test("full lifecycle: start → workers → merges → complete", () => {
    state = createInitialTuiState(3);

    const w1Running = makeWorkerState({ id: "w1", status: "running" });
    const w2Running = makeWorkerState({ id: "w2", status: "running" });
    const w1Done = makeWorkerState({ id: "w1", status: "completed" });
    const w2Done = makeWorkerState({ id: "w2", status: "completed" });

    // Phase 1: parallel starts
    apply({ type: "parallel:started", timestamp: ts() });
    expect(state.header.activeWorkers).toBe(0);

    // Phase 2: workers created and started
    apply({ type: "worker:created", timestamp: ts(), workerId: "w1" }, () => [w1Running]);
    apply({ type: "worker:created", timestamp: ts(), workerId: "w2" }, () => [w1Running, w2Running]);
    expect(state.header.activeWorkers).toBe(2);
    expect(state.workers).toHaveLength(2);

    // Phase 3: worker progress events
    apply({ type: "worker:progress", timestamp: ts(), workerId: "w1", iteration: 2, maxIterations: 3, elapsedMs: 1000, status: "running" }, () => [w1Running, w2Running]);
    expect(state.workers).toHaveLength(2);

    // Phase 4: workers complete
    apply({ type: "worker:completed", timestamp: ts(), workerId: "w1" }, () => [w1Done, w2Running]);
    expect(state.header.activeWorkers).toBe(1);

    apply({ type: "worker:completed", timestamp: ts(), workerId: "w2" }, () => [w1Done, w2Done]);
    expect(state.header.activeWorkers).toBe(0);

    // Phase 5: merge queue
    apply({ type: "merge:queued", timestamp: ts(), operationId: "m1", taskId: "FIX-001" });
    apply({ type: "merge:queued", timestamp: ts(), operationId: "m2", taskId: "FIX-002" });
    expect(state.mergeItems).toHaveLength(2);

    apply({ type: "merge:started", timestamp: ts(), operationId: "m1", taskId: "FIX-001" });
    expect(state.mergeItems[0].status).toBe("in-progress");

    apply({ type: "merge:completed", timestamp: ts(), operationId: "m1", taskId: "FIX-001" });
    expect(state.header.mergedTasks).toBe(1);

    apply({ type: "merge:started", timestamp: ts(), operationId: "m2", taskId: "FIX-002" });
    apply({ type: "merge:completed", timestamp: ts(), operationId: "m2", taskId: "FIX-002" });
    expect(state.header.mergedTasks).toBe(2);

    // Phase 6: parallel completes
    apply({ type: "parallel:completed", timestamp: ts() });
    expect(state.header.activeWorkers).toBe(0);
    expect(state.header.mergedTasks).toBe(2);
    expect(state.mergeItems.every((m) => m.status === "completed")).toBe(true);
  });
});
