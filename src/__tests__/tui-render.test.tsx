import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { act } from "react";
import { DashboardView } from "../tui/DashboardView.js";
import type { Task } from "../tasks/types.js";
import type { TuiEngineData } from "../tui/types.js";

const actEnv = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function makeTuiData(overrides: Partial<TuiEngineData> = {}): TuiEngineData {
  return {
    engineState: "executing",
    iteration: 2,
    maxIterations: 5,
    tasks: [],
    currentTaskId: null,
    output: "",
    agentName: "test-agent",
    projectName: "test-project",
    sessionId: "sess-123",
    startTime: Date.now() - 65_000,
    interviewMessages: [],
    isThinking: false,
    currentPhase: "Streaming response...",
    phaseStartTime: Date.now() - 5_000,
    completionSummary: null,
    taskOutputMap: {},
    taskElapsedMs: {},
    taskStartTimes: {},
    iterationEntries: [],
    configDisplay: "",
    tokenUsage: {
      sessionTotal: { inputTokens: 120, outputTokens: 80, totalTokens: 200 },
      taskTotals: {},
      hasData: true,
    },
    ...overrides,
  };
}

describe("TUI rendering", () => {
  test("renders dashboard labels for mocked engine state", async () => {
    const tasks: Task[] = [
      {
        id: "MODU-009",
        title: "Render TUI Output",
        description: "Render a mocked dashboard view.",
        acceptanceCriteria: ["Dashboard labels render."],
        priority: 3,
        status: "in_progress",
        iterationCount: 1,
      },
      {
        id: "MODU-010",
        title: "Verify Dashboard View",
        description: "Ensure output contains expected sections.",
        acceptanceCriteria: ["Expected sections are visible."],
        priority: 4,
        status: "open",
        iterationCount: 0,
      },
    ];

    const data = makeTuiData({
      tasks,
      currentTaskId: "MODU-009",
      output: "Running bun test...\n",
      taskOutputMap: { "MODU-009": "Running bun test...\n" },
      taskStartTimes: { "MODU-009": Date.now() - 12_000 },
      tokenUsage: {
        sessionTotal: { inputTokens: 120, outputTokens: 80, totalTokens: 200 },
        taskTotals: {
          "MODU-009": { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
        },
        hasData: true,
      },
    });

    const prevActEnv = actEnv.IS_REACT_ACT_ENVIRONMENT;
    actEnv.IS_REACT_ACT_ENVIRONMENT = true;
    const setup = await createTestRenderer({ width: 120, height: 30 });
    const root = createRoot(setup.renderer);

    try {
      await act(async () => {
        root.render(<DashboardView state={{ ...data, view: "dashboard" }} />);
      });
      await act(async () => {
        await setup.renderOnce();
      });
      const frame = setup.captureCharFrame();

      expect(frame).toContain("Dashboard");
      expect(frame).toContain("Active:");
      expect(frame).toContain("MODU-009");
      expect(frame).toContain("TOTAL");
    } finally {
      await act(async () => {
        root.unmount();
      });
      setup.renderer.destroy();
      actEnv.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    }
  });
});
