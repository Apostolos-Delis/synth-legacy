import { describe, test, expect } from "bun:test";
import { ReviewOrchestrator } from "../review/orchestrator.js";
import type { AgentAdapter, AgentExecuteOptions, AgentExecutionHandle, AgentExecutionResult } from "../agents/types.js";
import type { SynthConfig } from "../config/types.js";
import type { TaskFile } from "../tasks/types.js";
import { makeSessionPaths, makeTask, makeTaskFile, withTmpDir } from "./helpers.js";
import { writeText, writeJson, readText, readJson, ensureDir } from "../utils/fs.js";

// ── Canned review findings (structured markdown the Reviewer can parse) ──

const CANNED_FINDINGS = `
### [CRITICAL] Missing input validation
**File**: \`src/api/handler.ts\`
**Lines**: 42-50
**Description**: User input is passed directly to query without sanitization
**Suggestion**: Add zod schema validation before processing

### [WARNING] Unbounded list fetch
**File**: \`src/routes/list.ts\`
**Lines**: 10-15
**Description**: No pagination on list endpoint
**Suggestion**: Add limit/offset parameters
`.trim();

// ── Mock AgentAdapter ────────────────────────────────────────────────────

function createMockAgent(): { agent: AgentAdapter; getCallCount: () => number } {
  let callCount = 0;

  const agent: AgentAdapter = {
    name: "mock",
    async detect() {
      return { available: true, version: "1.0.0" };
    },
    execute(prompt: string, options: AgentExecuteOptions): AgentExecutionHandle {
      callCount++;
      const isReviewGeneration = callCount === 1;
      const output = isReviewGeneration
        ? CANNED_FINDINGS
        : `Task completed.\n<promise>COMPLETE</promise>`;

      // Stream output via onStdout before resolving the promise
      options.onStdout?.(output);

      return {
        pid: process.pid,
        promise: Promise.resolve({
          exitCode: 0,
          stdout: output,
          stderr: "",
          timedOut: false,
          firstTokenMs: 10,
        } satisfies AgentExecutionResult),
        interrupt() {},
      };
    },
    dispose() {},
  };

  return { agent, getCallCount: () => callCount };
}

// ── Config ───────────────────────────────────────────────────────────────

const config: SynthConfig = {
  project: { name: "test-project", branch: "test-branch", base_branch: "main" },
  agent: { name: "claude", timeout: 30_000, skip_permissions: true },
  execution: { max_iterations: 10, iteration_delay: 0, auto_commit: false },
  guardrails: { max_consecutive_failures: 3, backpressure_commands: [] },
  finalize: {
    auto_format: false,
    split_commits: false,
    self_review: false,
    create_pr: false,
  },
};

// ── Integration test ─────────────────────────────────────────────────────

describe("review pipeline integration", () => {
  test("full review pipeline with mock agent", async () => {
    await withTmpDir(async (dir) => {
      const sessionPaths = makeSessionPaths(dir);

      // Set up session directory with completed first-pass tasks
      const completedTasks = makeTaskFile([
        makeTask({ id: "US-001", title: "Implement API handler", status: "done" }),
        makeTask({ id: "US-002", title: "Add list endpoint", status: "done" }),
      ]);

      await Promise.all([
        writeText(sessionPaths.prd, "# PRD\n\nBuild a REST API with input validation and pagination."),
        writeText(sessionPaths.progress, "## Iteration 1 - US-001: Implement API handler\n- Status: done\n---\n## Iteration 2 - US-002: Add list endpoint\n- Status: done\n---\n"),
        writeJson(sessionPaths.tasks, completedTasks),
        writeJson(sessionPaths.run, {
          id: "run-test",
          sessionId: "test-session",
          status: "running",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          agent: "mock",
          currentIteration: 2,
          maxIterations: 10,
          cwd: dir,
        }),
        ensureDir(sessionPaths.logs),
      ]);

      // Create mock agent and run orchestrator
      const { agent, getCallCount } = createMockAgent();
      const orchestrator = new ReviewOrchestrator(config, agent, null, sessionPaths, dir);

      const events: string[] = [];
      orchestrator.on((event) => events.push(event.type));

      const result = await orchestrator.run();

      // ── AC #1: Mock agent returns canned findings ─────────────────
      // First call was review generation, subsequent calls were task execution
      // 2 findings → 2 review tasks → 3 total calls (1 generation + 2 execution)
      expect(getCallCount()).toBe(3);

      // ── AC #2: review/findings.md created with non-empty content ──
      const findingsContent = await readText(sessionPaths.reviewFindings);
      expect(findingsContent.length).toBeGreaterThan(0);
      expect(findingsContent).toContain("[CRITICAL]");
      expect(findingsContent).toContain("[WARNING]");
      expect(findingsContent).toContain("Missing input validation");
      expect(findingsContent).toContain("Unbounded list fetch");

      // ── AC #3: review/tasks.json contains valid tasks from findings ─
      const reviewTaskFile = await readJson<TaskFile>(sessionPaths.reviewTasks);
      expect(reviewTaskFile.tasks).toHaveLength(2);
      expect(reviewTaskFile.project).toBe("test-project");
      expect(reviewTaskFile.branchName).toBe("test-branch");

      // Tasks have RVW- prefixed IDs
      expect(reviewTaskFile.tasks[0].id).toBe("RVW-001");
      expect(reviewTaskFile.tasks[1].id).toBe("RVW-002");

      // Priority mapped from severity
      expect(reviewTaskFile.tasks[0].priority).toBe(1); // critical
      expect(reviewTaskFile.tasks[1].priority).toBe(2); // warning

      // Acceptance criteria derived from suggestions
      expect(reviewTaskFile.tasks[0].acceptanceCriteria).toContain(
        "Add zod schema validation before processing",
      );
      expect(reviewTaskFile.tasks[1].acceptanceCriteria).toContain(
        "Add limit/offset parameters",
      );

      // ── AC #4: Review tasks executed through Engine (all marked done) ─
      expect(result.executed).toBe(true);
      expect(result.findings).toHaveLength(2);
      expect(result.taskFile).not.toBeNull();

      // Tasks are marked done in the persisted file after Engine completes
      const finalTaskFile = await readJson<TaskFile>(sessionPaths.reviewTasks);
      for (const task of finalTaskFile.tasks) {
        expect(task.status).toBe("done");
      }

      // ── AC #5: No third review pass ──────────────────────────────
      // The orchestrator returns after Engine completes review tasks.
      // If a third pass occurred, callCount would be > 3.
      // (1 review generation + 2 task executions = 3 total)
      expect(getCallCount()).toBe(3);

      // Engine emitted completion events
      expect(events).toContain("state:change");
      expect(events).toContain("complete");
    });
  });

  test("review pipeline with zero findings skips execution", async () => {
    await withTmpDir(async (dir) => {
      const sessionPaths = makeSessionPaths(dir);

      await Promise.all([
        writeText(sessionPaths.prd, "# PRD\n\nSimple task."),
        writeText(sessionPaths.progress, "## Iteration 1\n- Status: done\n---\n"),
      ]);

      // Agent returns empty findings — no structured markdown
      let callCount = 0;
      const agent: AgentAdapter = {
        name: "mock-clean",
        async detect() {
          return { available: true };
        },
        execute(_prompt: string, options: AgentExecuteOptions): AgentExecutionHandle {
          callCount++;
          const output = "Everything looks good! No issues found.";
          options.onStdout?.(output);
          return {
            pid: process.pid,
            promise: Promise.resolve({
              exitCode: 0,
              stdout: output,
              stderr: "",
              timedOut: false,
            }),
            interrupt() {},
          };
        },
        dispose() {},
      };

      const orchestrator = new ReviewOrchestrator(config, agent, null, sessionPaths, dir);
      const result = await orchestrator.run();

      // Only the review generation call — no task execution
      expect(callCount).toBe(1);
      expect(result.findings).toHaveLength(0);
      expect(result.taskFile).toBeNull();
      expect(result.executed).toBe(false);

      // findings.md still written (contains the "no issues" response)
      const findingsContent = await readText(sessionPaths.reviewFindings);
      expect(findingsContent).toContain("No issues found");
    });
  });
});
