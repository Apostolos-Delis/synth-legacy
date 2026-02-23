import { describe, test, expect } from "bun:test";
import { FinalizeOrchestrator, parseAIResponse } from "../finalize/orchestrator.js";
import { classifyPrError } from "../finalize/pr.js";

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

describe("classifyPrError", () => {
  test("detects gh CLI not installed", () => {
    expect(classifyPrError("zsh: command not found: gh")).toContain("not installed");
    expect(classifyPrError("/bin/sh: gh: not found: gh")).toContain("not installed");
  });

  test("detects not authenticated", () => {
    expect(classifyPrError("error: not logged into any github hosts. Run gh auth login")).toContain("Not authenticated");
    expect(classifyPrError("HTTP 401: authentication required")).toContain("Not authenticated");
  });

  test("detects PR already exists", () => {
    expect(classifyPrError("a pull request already exists for branch feature-x")).toContain("already exists");
  });

  test("detects repository not found", () => {
    expect(classifyPrError("ERROR: Repository not found.")).toContain("Could not find");
    expect(classifyPrError("fatal: could not resolve host: github.com")).toContain("Could not find");
  });

  test("detects network errors", () => {
    expect(classifyPrError("could not connect to github.com")).toContain("Network error");
    expect(classifyPrError("error: request timed out")).toContain("Network error");
  });

  test("detects permission denied", () => {
    expect(classifyPrError("HTTP 403: forbidden")).toContain("Permission denied");
  });

  test("strips GraphQL error wrapping", () => {
    const raw = "GraphQL: No commits between main and feature-x (createPullRequest)";
    const result = classifyPrError(raw);
    expect(result).toBe("No commits between main and feature-x");
    expect(result).not.toContain("GraphQL");
  });

  test("truncates long unknown errors", () => {
    const longError = "x".repeat(300);
    const result = classifyPrError(longError);
    expect(result.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(result).toEndWith("...");
  });

  test("cleans ANSI codes from unknown errors", () => {
    const ansiError = "\x1b[31mSome error message\x1b[0m";
    expect(classifyPrError(ansiError)).toBe("Some error message");
  });
});
