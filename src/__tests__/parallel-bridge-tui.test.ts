import { describe, test, expect } from "bun:test";
import { ParallelBridge, SerialBridge } from "../tui/ParallelBridge.js";
import { createInitialTuiState, buildFixTuiData } from "../finalize/parallel-bridge.js";
import type { TuiEngineData } from "../tui/types.js";

function makeTuiData(overrides?: Partial<TuiEngineData>): TuiEngineData {
  return {
    engineState: "executing",
    iteration: 0,
    maxIterations: 1,
    tasks: [],
    currentTaskId: null,
    output: "",
    agentName: "test",
    projectName: "test",
    sessionId: "test-session",
    startTime: Date.now(),
    interviewMessages: [],
    isThinking: false,
    currentPhase: null,
    phaseStartTime: null,
    completionSummary: null,
    taskOutputMap: {},
    taskElapsedMs: {},
    taskStartTimes: {},
    iterationEntries: [],
    configDisplay: "",
    tokenUsage: { sessionTotal: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, taskTotals: {}, hasData: false },
    ...overrides,
  };
}

describe("ParallelBridge", () => {
  test("exports ParallelBridge as a function component", () => {
    expect(typeof ParallelBridge).toBe("function");
    expect(ParallelBridge.name).toBe("ParallelBridge");
  });

  test("exports SerialBridge as a function component", () => {
    expect(typeof SerialBridge).toBe("function");
    expect(SerialBridge.name).toBe("SerialBridge");
  });
});

describe("TuiEngineData._notify contract", () => {
  test("_notify field can be set and called on TuiEngineData", () => {
    const data = makeTuiData();
    expect(data._notify).toBeUndefined();

    let called = false;
    data._notify = () => { called = true; };
    data._notify();
    expect(called).toBe(true);
  });

  test("_notify can be cleared back to undefined", () => {
    const data = makeTuiData();
    data._notify = () => {};
    data._notify = undefined;
    expect(data._notify).toBeUndefined();
  });

  test("optional chaining on _notify is safe when undefined", () => {
    const data = makeTuiData();
    expect(() => data._notify?.()).not.toThrow();
  });

  test("buildFixTuiData produces objects that accept _notify", () => {
    const data = buildFixTuiData(
      [],
      { agent: { name: "a" }, project: { name: "p" } },
      "sess-1",
    );
    let callCount = 0;
    data._notify = () => { callCount++; };
    data._notify();
    data._notify();
    expect(callCount).toBe(2);
  });
});

describe("destroyed guard pattern", () => {
  test("parallelDestroyed flag prevents notify after destruction", async () => {
    const data = makeTuiData();
    let notifyCount = 0;
    data._notify = () => { notifyCount++; };

    let destroyed = false;
    let renderScheduled = false;

    const notifyThrottled = () => {
      if (destroyed || renderScheduled) return;
      renderScheduled = true;
      setTimeout(() => {
        renderScheduled = false;
        if (!destroyed) data._notify?.();
      }, 16);
    };

    // Normal operation: notify fires
    notifyThrottled();
    await new Promise((r) => setTimeout(r, 30));
    expect(notifyCount).toBe(1);

    // After destruction: notify is suppressed
    destroyed = true;
    notifyThrottled();
    await new Promise((r) => setTimeout(r, 30));
    expect(notifyCount).toBe(1); // still 1 — no new call

    // Even if _notify is cleared (simulating unmount cleanup)
    data._notify = undefined;
    notifyThrottled();
    await new Promise((r) => setTimeout(r, 30));
    expect(notifyCount).toBe(1);
  });

  test("in-flight setTimeout is suppressed when destroyed between schedule and fire", async () => {
    const data = makeTuiData();
    let notifyCount = 0;
    data._notify = () => { notifyCount++; };

    let destroyed = false;
    let renderScheduled = false;

    const notifyThrottled = () => {
      if (destroyed || renderScheduled) return;
      renderScheduled = true;
      setTimeout(() => {
        renderScheduled = false;
        if (!destroyed) data._notify?.();
      }, 16);
    };

    // Schedule a notify, then destroy before it fires
    notifyThrottled();
    destroyed = true;
    await new Promise((r) => setTimeout(r, 30));
    expect(notifyCount).toBe(0); // suppressed by inner guard
  });
});

describe("createInitialTuiState", () => {
  test("creates state with correct totalTasks", () => {
    const state = createInitialTuiState(5);
    expect(state.header.totalTasks).toBe(5);
    expect(state.header.currentWave).toBe(0);
    expect(state.header.activeWorkers).toBe(0);
    expect(state.workers).toEqual([]);
    expect(state.mergeItems).toEqual([]);
    expect(state.conflict).toBeNull();
  });
});
