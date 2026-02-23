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
    expect(result.questionGroups).toEqual([]);
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

describe("parseAIResponse — recommended and question groups", () => {
  test("[OPTION*] is parsed as recommended: true", () => {
    const raw = "Choose:\n[OPTION*]Retry|Retry with backoff[/OPTION]\n[OPTION]Skip|Skip this step[/OPTION]";
    const result = parseAIResponse(raw);
    expect(result.options).toHaveLength(2);
    expect(result.options[0].recommended).toBe(true);
    expect(result.options[0].label).toBe("Retry");
    expect(result.options[0].description).toBe("Retry with backoff");
  });

  test("[OPTION] without * has no recommended property", () => {
    const raw = "[OPTION]Fix it|Apply the fix[/OPTION]";
    const result = parseAIResponse(raw);
    expect(result.options).toHaveLength(1);
    expect(result.options[0].recommended).toBeUndefined();
  });

  test("[QUESTION] groups with associated options", () => {
    const raw = [
      "Some context text.",
      "[QUESTION]Error handling[/QUESTION]",
      "[OPTION*]Retry|Retry with backoff[/OPTION]",
      "[OPTION]Propagate|Let caller handle[/OPTION]",
      "[QUESTION]Logging[/QUESTION]",
      "[OPTION]Debug|Debug level[/OPTION]",
      "[OPTION*]Info|Info level[/OPTION]",
    ].join("\n");

    const result = parseAIResponse(raw);
    expect(result.questionGroups).toHaveLength(2);

    expect(result.questionGroups[0].question).toBe("Error handling");
    expect(result.questionGroups[0].options).toHaveLength(2);
    expect(result.questionGroups[0].options[0].recommended).toBe(true);
    expect(result.questionGroups[0].options[0].label).toBe("Retry");

    expect(result.questionGroups[1].question).toBe("Logging");
    expect(result.questionGroups[1].options).toHaveLength(2);
    expect(result.questionGroups[1].options[1].recommended).toBe(true);
    expect(result.questionGroups[1].options[1].label).toBe("Info");

    // Flattened options should contain all 4
    expect(result.options).toHaveLength(4);
  });

  test("backward compat: no [QUESTION] markers → single group with empty question", () => {
    const raw = "[OPTION]A|Option A[/OPTION]\n[OPTION]B|Option B[/OPTION]";
    const result = parseAIResponse(raw);
    expect(result.questionGroups).toHaveLength(1);
    expect(result.questionGroups[0].question).toBe("");
    expect(result.questionGroups[0].options).toHaveLength(2);
  });

  test("no options → empty questionGroups", () => {
    const raw = "Just some text with no markers.";
    const result = parseAIResponse(raw);
    expect(result.questionGroups).toEqual([]);
    expect(result.options).toEqual([]);
  });

  test("[QUESTION] and [OPTION] markers are stripped from content", () => {
    const raw = "Intro text.\n[QUESTION]Topic[/QUESTION]\n[OPTION*]Yes|Do it[/OPTION]\n[OPTION]No|Don't[/OPTION]\nTrailing.";
    const result = parseAIResponse(raw);
    expect(result.content).not.toContain("[QUESTION]");
    expect(result.content).not.toContain("[/QUESTION]");
    expect(result.content).not.toContain("[OPTION");
    expect(result.content).not.toContain("[/OPTION]");
    expect(result.content).toContain("Intro text.");
    expect(result.content).toContain("Trailing.");
  });

  test("mixed [FIX] and [OPTION*] markers are all parsed", () => {
    const raw = "Review:\n[FIX]Add null check[/FIX]\n[OPTION*]Apply fix|Apply immediately[/OPTION]\n[OPTION]Defer|Handle later[/OPTION]";
    const result = parseAIResponse(raw);
    expect(result.fixDescriptions).toEqual(["Add null check"]);
    expect(result.options).toHaveLength(2);
    expect(result.options[0].recommended).toBe(true);
  });

  test("[QUESTION] with no options produces a group with empty options array", () => {
    const raw = "[QUESTION]Empty topic[/QUESTION]\nSome text but no options here.";
    const result = parseAIResponse(raw);
    expect(result.questionGroups).toHaveLength(1);
    expect(result.questionGroups[0].question).toBe("Empty topic");
    expect(result.questionGroups[0].options).toEqual([]);
  });

  test("options before first [QUESTION] are captured in a preamble group", () => {
    const raw = [
      "[OPTION]Orphan|Orphaned option[/OPTION]",
      "[QUESTION]Topic[/QUESTION]",
      "[OPTION]Real|Real option[/OPTION]",
    ].join("\n");

    const result = parseAIResponse(raw);
    expect(result.questionGroups).toHaveLength(2);
    // First group is the preamble with orphaned option
    expect(result.questionGroups[0].question).toBe("");
    expect(result.questionGroups[0].options).toHaveLength(1);
    expect(result.questionGroups[0].options[0].label).toBe("Orphan");
    // Second group is the actual [QUESTION]
    expect(result.questionGroups[1].question).toBe("Topic");
    expect(result.questionGroups[1].options).toHaveLength(1);
    expect(result.questionGroups[1].options[0].label).toBe("Real");
    // Flattened options should contain all 2
    expect(result.options).toHaveLength(2);
  });
});
