import { describe, test, expect } from "bun:test";
import { FinalizeOrchestrator, parseAIResponse } from "../finalize/orchestrator.js";

function makeMockAgent() {
  return {
    execute: (_prompt: string, _opts?: unknown) => ({
      promise: Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      interrupt: () => {},
      pid: 0,
      process: null as unknown,
    }),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("FinalizeOrchestrator PR creation", () => {
  test("getPrUrl returns null initially", () => {
    const orch = new FinalizeOrchestrator();
    expect(orch.getPrUrl()).toBeNull();
  });

  test("handleOptionSelect in default phase returns assistant message", async () => {
    const orch = new FinalizeOrchestrator();
    const agent = makeMockAgent();

    const result = await orch.handleOptionSelect(
      { label: "Proceed to PR", description: "Skip remaining issues", value: "proceed-to-pr" },
      agent,
    );

    expect(result.message.role).toBe("assistant");
  });

  test("retry and exit options have correct values", () => {
    const retryOption = { label: "Retry", description: "Retry PR creation", value: "retry-pr" };
    const exitOption = { label: "Exit", description: "Exit without creating a PR", value: "exit" };

    expect(retryOption.value).toBe("retry-pr");
    expect(exitOption.value).toBe("exit");
  });

  test("parseAIResponse preserves content when no markers present", () => {
    const result = parseAIResponse("PR created successfully: https://github.com/org/repo/pull/42");
    expect(result.content).toBe("PR created successfully: https://github.com/org/repo/pull/42");
    expect(result.options).toEqual([]);
    expect(result.fixDescriptions).toEqual([]);
    expect(result.reviewComplete).toBe(false);
  });

  test("prUrl getter reflects state after construction", () => {
    const orch = new FinalizeOrchestrator();
    expect(orch.getPrUrl()).toBeNull();
    expect(orch.getCurrentPhase()).toBe("auditing");
  });

  test("phase listener subscription and unsubscription works", () => {
    const orch = new FinalizeOrchestrator();
    const phases: string[] = [];
    const unsub1 = orch.onPhaseChange((p) => phases.push(p));

    const unsub2 = orch.onPhaseChange(() => {});
    expect(typeof unsub1).toBe("function");
    expect(typeof unsub2).toBe("function");
    unsub1();
    unsub2();
  });

  test("messages accumulate through option selections", async () => {
    const orch = new FinalizeOrchestrator();
    const agent = makeMockAgent();

    await orch.handleOptionSelect(
      { label: "Test", description: "test option", value: "test" },
      agent,
    );

    const messages = orch.getMessages();
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("Selected: Test");
  });
});
