import { describe, test, expect } from "bun:test";
import { Engine } from "../engine/engine.js";
import type {
  AgentAdapter,
  AgentExecuteOptions,
  AgentExecutionHandle,
  AgentExecutionResult,
} from "../agents/types.js";
import type { SynthConfig } from "../config/types.js";
import type { EngineEvent } from "../engine/types.js";
import { makeSessionPaths, makeTask, makeTaskFile, withTmpDir } from "./helpers.js";
import { writeText, writeJson, ensureDir } from "../utils/fs.js";

function makeConfig(overrides?: Partial<SynthConfig["execution"]>): SynthConfig {
  return {
    project: { name: "test", branch: "test", base_branch: "main" },
    agent: { name: "mock", timeout: 5000, skip_permissions: true },
    execution: { max_iterations: 10, iteration_delay: 0, auto_commit: false, ...overrides },
    guardrails: { max_consecutive_failures: 3, backpressure_commands: [] },
    finalize: { auto_format: false, split_commits: false, self_review: false, create_pr: false },
  };
}

function createAgent(output: string): AgentAdapter {
  return {
    name: "mock",
    async detect() {
      return { available: true };
    },
    execute(_prompt: string, options: AgentExecuteOptions): AgentExecutionHandle {
      options.onStdout?.(output);
      return {
        pid: process.pid,
        promise: Promise.resolve({
          exitCode: 0,
          stdout: output,
          stderr: "",
          timedOut: false,
          firstTokenMs: 5,
        } satisfies AgentExecutionResult),
        interrupt() {},
      };
    },
    dispose() {},
  };
}

describe("engine completion", () => {
  test("engine reaches completed state when all tasks are done", async () => {
    await withTmpDir(async (dir) => {
      const sessionPaths = makeSessionPaths(dir);
      const taskFile = makeTaskFile([
        makeTask({ id: "T-001", title: "Only task", status: "open" }),
      ]);

      await Promise.all([
        writeJson(sessionPaths.tasks, taskFile),
        writeText(sessionPaths.prd, "# PRD\nTest"),
        writeText(sessionPaths.progress, ""),
        writeJson(sessionPaths.run, {
          id: "run-1",
          sessionId: "s-1",
          status: "running",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          agent: "mock",
          currentIteration: 0,
          maxIterations: 10,
          cwd: dir,
        }),
        ensureDir(sessionPaths.logs),
      ]);

      const agent = createAgent("Done.\n<promise>COMPLETE</promise>");
      const engine = new Engine(makeConfig(), agent, null, sessionPaths, dir);

      const events: EngineEvent[] = [];
      engine.on((e) => events.push(e));

      await engine.run();

      expect(engine.getState()).toBe("completed");
      expect(events.some((e) => e.type === "complete")).toBe(true);
    });
  });

  test("stdout events do not contain <promise>COMPLETE</promise>", async () => {
    await withTmpDir(async (dir) => {
      const sessionPaths = makeSessionPaths(dir);
      const taskFile = makeTaskFile([
        makeTask({ id: "T-001", title: "Only task", status: "open" }),
      ]);

      await Promise.all([
        writeJson(sessionPaths.tasks, taskFile),
        writeText(sessionPaths.prd, "# PRD\nTest"),
        writeText(sessionPaths.progress, ""),
        writeJson(sessionPaths.run, {
          id: "run-1",
          sessionId: "s-1",
          status: "running",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          agent: "mock",
          currentIteration: 0,
          maxIterations: 10,
          cwd: dir,
        }),
        ensureDir(sessionPaths.logs),
      ]);

      const agent = createAgent("All done.\n<promise>COMPLETE</promise>\nExtra text.");
      const engine = new Engine(makeConfig(), agent, null, sessionPaths, dir);

      const stdoutMessages: string[] = [];
      engine.on((e) => {
        if (e.type === "agent:stdout" && e.message) {
          stdoutMessages.push(e.message);
        }
      });

      await engine.run();

      const allOutput = stdoutMessages.join("");
      expect(allOutput).not.toContain("<promise>COMPLETE</promise>");
      expect(allOutput).toContain("All done.");
      expect(allOutput).toContain("Extra text.");
    });
  });

  test("completion is determined before autoCommit runs", async () => {
    await withTmpDir(async (dir) => {
      const sessionPaths = makeSessionPaths(dir);
      const taskFile = makeTaskFile([
        makeTask({ id: "T-001", title: "Only task", status: "open" }),
      ]);

      await Promise.all([
        writeJson(sessionPaths.tasks, taskFile),
        writeText(sessionPaths.prd, "# PRD\nTest"),
        writeText(sessionPaths.progress, ""),
        writeJson(sessionPaths.run, {
          id: "run-1",
          sessionId: "s-1",
          status: "running",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          agent: "mock",
          currentIteration: 0,
          maxIterations: 10,
          cwd: dir,
        }),
        ensureDir(sessionPaths.logs),
      ]);

      const agent = createAgent("Done.\n<promise>COMPLETE</promise>");

      // auto_commit enabled — but since this isn't a git repo, git add will fail.
      // The key assertion: engine still reaches "completed" despite autoCommit failure.
      const engine = new Engine(
        makeConfig({ auto_commit: true }),
        agent,
        null,
        sessionPaths,
        dir,
      );

      const events: string[] = [];
      engine.on((e) => events.push(e.type));

      await engine.run();

      expect(engine.getState()).toBe("completed");
      // task:complete fires before the complete event
      const completeIdx = events.indexOf("complete");
      const taskCompleteIdx = events.indexOf("task:complete");
      expect(taskCompleteIdx).toBeLessThan(completeIdx);
    });
  });
});
