import { describe, test, expect } from "bun:test";
import { FinalizeOrchestrator } from "./orchestrator.js";
import type { AgentAdapter } from "../agents/types.js";
import type { SynthConfig } from "../config/types.js";
import type { SessionPaths } from "../sessions/types.js";
import type { FinalizeMessage, OrchestratorState } from "./chat-types.js";

const mockAgent: AgentAdapter = {
  name: "mock",
  detect: async () => ({ available: true }),
  execute: (_prompt: string) => ({
    pid: 0,
    promise: Promise.resolve({
      exitCode: 0,
      stdout: "No new issues found. Everything looks clean.",
      stderr: "",
      timedOut: false,
    }),
    interrupt: () => {},
  }),
  dispose: () => {},
};

function makeConfig(overrides: Partial<SynthConfig> = {}): SynthConfig {
  return {
    project: { name: "test", base_branch: "main", repo_root: "/tmp" },
    agent: { name: "mock", model: "test" },
    execution: { max_iterations: 5 },
    ...overrides,
  } as SynthConfig;
}

function makeSessionPaths(): SessionPaths {
  return {
    root: "/tmp/test-session",
    prd: "/tmp/test-session/prd.md",
    tasks: "/tmp/test-session/tasks.json",
    logs: "/tmp/test-session/logs",
    progress: "/tmp/test-session/progress.md",
    review: "/tmp/test-session/review.json",
    plannerConversation: "/tmp/test-session/planner-conversation.json",
  } as SessionPaths;
}

function makeMockSpawn(stdout = "") {
  return () => ({
    pid: 0,
    promise: Promise.resolve({ exitCode: 0, stdout, stderr: "", timedOut: false }),
    interrupt: () => {},
  });
}

describe("FinalizeOrchestrator.completeFixExecution", () => {
  test("appends summary message and calls recheckAfterFixes", async () => {
    const config = makeConfig();
    const sessionPaths = makeSessionPaths();
    const messages: FinalizeMessage[] = [];

    const orchestrator = new FinalizeOrchestrator({
      spawn: makeMockSpawn(""),
      loadTasks: async () => ({ project: "test", branchName: "test", description: "", tasks: [] }),
    });

    // Restore with some state so the engine is initialized and we're in executing-fixes
    const savedState: OrchestratorState = {
      phase: "collecting-fixes",
      fixes: [],
      confirmedFixes: [
        {
          id: "FIX-001",
          description: "Fix something",
          acceptanceCriteria: ["It works"],
          priority: 2,
          status: "accepted",
          sourceIssue: { severity: "major", category: "code-review", description: "Something broken" },
        },
      ],
      reviewIndex: 0,
      fixCounter: 1,
      messages: [{ role: "assistant", content: "Initial audit" }],
    };

    orchestrator.restore(mockAgent, config, sessionPaths, "/tmp", savedState.messages, savedState);

    const onMessage = (msg: FinalizeMessage) => messages.push(msg);
    const result = await orchestrator.completeFixExecution(3, 1, mockAgent, config, sessionPaths, onMessage);

    // Should append a summary message
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].content).toContain("3/4");
    expect(messages[0].content).toContain("1 failed");

    // Should have called recheckAfterFixes (which appends recheck messages)
    const allMessages = orchestrator.getMessages();
    const recheckMsg = allMessages.find((m) => m.content.includes("Re-checking"));
    expect(recheckMsg).toBeDefined();

    // Result should be an OrchestratorResponse with a message
    expect(result.message).toBeDefined();
    expect(result.message.role).toBe("assistant");
  });

  test("reports zero failures cleanly", async () => {
    const config = makeConfig();
    const sessionPaths = makeSessionPaths();
    const messages: FinalizeMessage[] = [];

    const orchestrator = new FinalizeOrchestrator({
      spawn: makeMockSpawn(""),
      loadTasks: async () => ({ project: "test", branchName: "test", description: "", tasks: [] }),
    });

    const savedState: OrchestratorState = {
      phase: "collecting-fixes",
      fixes: [],
      confirmedFixes: [],
      reviewIndex: 0,
      fixCounter: 0,
      messages: [{ role: "assistant", content: "Audit" }],
    };
    orchestrator.restore(mockAgent, config, sessionPaths, "/tmp", savedState.messages, savedState);

    await orchestrator.completeFixExecution(5, 0, mockAgent, config, sessionPaths, (msg) => messages.push(msg));

    expect(messages[0].content).toContain("5/5");
    expect(messages[0].content).not.toContain("failed");
  });

  test("getConfirmedFixes returns a copy", () => {
    const orchestrator = new FinalizeOrchestrator({
      spawn: makeMockSpawn(),
      loadTasks: async () => ({ project: "test", branchName: "test", description: "", tasks: [] }),
    });

    const savedState: OrchestratorState = {
      phase: "collecting-fixes",
      fixes: [],
      confirmedFixes: [
        {
          id: "FIX-001",
          description: "Fix",
          acceptanceCriteria: [],
          priority: 2,
          status: "accepted",
          sourceIssue: { severity: "major", category: "test", description: "test" },
        },
      ],
      reviewIndex: 0,
      fixCounter: 1,
      messages: [{ role: "assistant", content: "Hi" }],
    };
    orchestrator.restore(mockAgent, makeConfig(), makeSessionPaths(), "/tmp", savedState.messages, savedState);

    const fixes = orchestrator.getConfirmedFixes();
    expect(fixes).toHaveLength(1);
    expect(fixes[0].id).toBe("FIX-001");

    // Mutating the returned array shouldn't affect internal state
    fixes.pop();
    expect(orchestrator.getConfirmedFixes()).toHaveLength(1);
  });
});
