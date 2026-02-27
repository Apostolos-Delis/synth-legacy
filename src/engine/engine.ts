import { basename, resolve } from "node:path";
import type { SynthConfig } from "../config/types.js";
import type { AgentAdapter, AgentExecutionResult } from "../agents/types.js";
import type { SessionPaths } from "../sessions/types.js";
import type { Task } from "../tasks/types.js";
import type { TaskFile } from "../tasks/types.js";
import type {
  EngineEvent,
  EngineEventListener,
  EngineState,
  IterationResult,
} from "./types.js";
import { parseAcDoneMarkers, stripAcDoneMarkers } from "./ac-done.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { detectRateLimit, getBackoffDelay } from "./rate-limit.js";
import { runBackpressure } from "./backpressure.js";
import { loadTasks, saveTasks, updateTaskStatus, allTasksDone, persistTaskStatus } from "../tasks/store.js";
import { selectNextTask } from "../tasks/selector.js";
import { buildPrompt, type PromptContext } from "../prompts/build.js";
import { appendText, writeText, ensureDir } from "../utils/fs.js";
import { getSessionSlug } from "../sessions/slug.js";
import { spawn } from "../utils/process.js";
import { updateRun } from "../run/run.js";
import { globalTrace } from "../utils/perf.js";
import { parseTokenUsageFromOutput } from "./tokens.js";
import { createPromptCache } from "./prompt-cache.js";

const COMPLETION_PATTERN = /<promise>COMPLETE<\/promise>/;

export class Engine {
  private state: EngineState = "idle";
  private iteration = 0;
  private shouldStop = false;
  private rateLimitAttempts = 0;
  private listeners: EngineEventListener[] = [];
  private circuitBreaker: CircuitBreaker;
  private activeInterrupt: (() => void) | null = null;
  private sessionSlug: string | null = null;
  private sessionId: string | null = null;
  private promptCache = createPromptCache();

  constructor(
    private config: SynthConfig,
    private agent: AgentAdapter,
    private fallbackAgent: AgentAdapter | null,
    private sessionPaths: SessionPaths,
    private cwd: string,
  ) {
    this.circuitBreaker = new CircuitBreaker(
      config.guardrails.max_consecutive_failures,
    );
  }

  on(listener: EngineEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private setState(newState: EngineState): void {
    this.state = newState;
    this.emit({ type: "state:change", message: newState });
  }

  getState(): EngineState {
    return this.state;
  }

  getIteration(): number {
    return this.iteration;
  }

  private getSessionId(): string {
    if (this.sessionId !== null) return this.sessionId;
    this.sessionId = basename(this.sessionPaths.root);
    return this.sessionId;
  }

  private async loadPromptContext(phase: string): Promise<PromptContext> {
    const sessionId = this.getSessionId();
    const [agents, progress] = await Promise.all([
      this.promptCache.readText({
        path: resolve(this.cwd, "AGENTS.md"),
        component: "agents",
        sessionId,
        phase,
      }),
      this.promptCache.readText({
        path: this.sessionPaths.progress,
        component: "progress",
        sessionId,
        phase,
      }),
    ]);

    return {
      projectContext: agents ?? undefined,
      progress: progress ?? undefined,
    };
  }

  pause(): void {
    this.shouldStop = true;
    this.setState("paused");
  }

  stop(): void {
    this.shouldStop = true;
    this.activeInterrupt?.();
  }

  private mergeCriteriaIntoTaskFile(taskFile: TaskFile, task: Task): TaskFile {
    return {
      ...taskFile,
      tasks: taskFile.tasks.map((t) =>
        t.id === task.id
          ? { ...t, criteriaCompleted: task.criteriaCompleted ?? t.criteriaCompleted }
          : t,
      ),
    };
  }

  private async handleRateLimit(
    taskId: string,
    result: AgentExecutionResult,
  ): Promise<{ rateLimited: boolean; delay: number }> {
    if (!detectRateLimit(result.stdout + result.stderr)) {
      this.rateLimitAttempts = 0;
      return { rateLimited: false, delay: 0 };
    }

    this.rateLimitAttempts++;
    const delay = getBackoffDelay(this.rateLimitAttempts);
    this.emit({
      type: "rate-limit:detected",
      message: `Rate limited, backing off ${delay / 1000}s`,
    });
    await persistTaskStatus(this.sessionPaths, taskId, "open");
    return { rateLimited: true, delay };
  }

  private async runBackpressureChecks(taskId: string): Promise<boolean> {
    if (this.config.guardrails.backpressure_commands.length === 0) {
      return true;
    }

    this.emit({ type: "backpressure:start", taskId });
    const bp = await runBackpressure(
      this.config.guardrails.backpressure_commands,
      this.cwd,
    );

    if (bp.passed) {
      this.emit({ type: "backpressure:pass", taskId });
    } else {
      this.emit({
        type: "backpressure:fail",
        taskId,
        message: bp.results
          .filter((r) => r.exitCode !== 0)
          .map((r) => `${r.command}: exit ${r.exitCode}`)
          .join(", "),
      });
    }

    return bp.passed;
  }

  private async autoCommit(task: Task): Promise<void> {
    const COMMIT_TIMEOUT = 30_000; // 30s — enough for pre-commit hooks
    if (this.sessionSlug === null) {
      this.sessionSlug = await getSessionSlug(this.sessionPaths);
    }
    const commitMsg = `feat: [${this.sessionSlug}] ${task.title}`;
    const addArgs = ["git", "add", "-A", "--", "."];
    const addResult = await spawn({ cmd: addArgs, cwd: this.cwd, timeout: COMMIT_TIMEOUT }).promise;
    if (addResult.exitCode !== 0) {
      this.emit({
        type: "task:failed",
        taskId: task.id,
        message: `git add failed (exit ${addResult.exitCode}): ${addResult.stderr}`,
      });
      return;
    }
    const stagedCheck = await spawn({
      cmd: ["git", "diff", "--cached", "--quiet"],
      cwd: this.cwd,
      timeout: COMMIT_TIMEOUT,
    }).promise;
    if (stagedCheck.exitCode === 0) {
      this.emit({
        type: "task:failed",
        taskId: task.id,
        message: "No staged changes after git add -A",
      });
      return;
    }
    const commitResult = await spawn({
      cmd: ["git", "commit", "-m", commitMsg, "--allow-empty"],
      cwd: this.cwd,
      timeout: COMMIT_TIMEOUT,
    }).promise;
    if (commitResult.exitCode !== 0) {
      const reason = commitResult.timedOut ? "timed out" : `exit ${commitResult.exitCode}`;
      this.emit({
        type: "task:failed",
        taskId: task.id,
        message: `git commit failed (${reason}): ${commitResult.stderr}`,
      });
    }
  }

  private async handleIterationSuccess(
    task: Task,
    freshTaskFile: TaskFile,
    duration: number,
  ): Promise<void> {
    const criteriaCount = task.acceptanceCriteria.length;
    const criteriaDone = task.criteriaCompleted
      ? task.criteriaCompleted.filter(Boolean).length
      : 0;

    if (task.criteriaCompleted) {
      for (let i = 0; i < task.criteriaCompleted.length; i++) {
        task.criteriaCompleted[i] = true;
      }
    }

    const mergedFile = this.mergeCriteriaIntoTaskFile(freshTaskFile, task);
    const doneFile = updateTaskStatus(mergedFile, task.id, "done", { durationMs: duration });
    await saveTasks(this.sessionPaths.tasks, doneFile);
    this.circuitBreaker.recordSuccess();
    this.emit({
      type: "task:complete",
      taskId: task.id,
      message: task.title,
    });

    const durationSec = Math.round(duration / 1000);
    const progressEntry = `## Iteration ${this.iteration} - ${task.id}: ${task.title}\n- Status: done\n- Duration: ${durationSec}s\n- Criteria: ${criteriaDone}/${criteriaCount} observed\n---\n`;
    await appendText(this.sessionPaths.progress, progressEntry);
  }

  /**
   * Returns true if the circuit breaker tripped (caller should break the loop).
   */
  private async handleIterationFailure(
    task: Task,
    freshTaskFile: TaskFile,
    result: AgentExecutionResult,
    backpressurePassed: boolean,
  ): Promise<boolean> {
    const failNotes = !backpressurePassed
      ? `Iteration ${this.iteration}: backpressure failed`
      : result.timedOut
        ? `Iteration ${this.iteration}: timed out`
        : `Iteration ${this.iteration}: agent exited with code ${result.exitCode}`;

    const mergedFile = this.mergeCriteriaIntoTaskFile(freshTaskFile, task);
    const failedFile = updateTaskStatus(mergedFile, task.id, "open", { notes: failNotes });
    await saveTasks(this.sessionPaths.tasks, failedFile);
    this.emit({
      type: "task:failed",
      taskId: task.id,
      message: failNotes,
    });

    if (this.circuitBreaker.recordFailure()) {
      this.emit({
        type: "circuit:trip",
        message: `Circuit breaker tripped after ${this.circuitBreaker.failures} consecutive failures`,
      });
      this.setState("blocked");
      return true;
    }

    return false;
  }

  async run(startIteration = 0): Promise<void> {
    this.iteration = startIteration;
    this.shouldStop = false;
    this.setState("executing");

    while (!this.shouldStop) {
      if (this.iteration >= this.config.execution.max_iterations) {
        this.emit({
          type: "state:change",
          message: `Reached max iterations (${this.config.execution.max_iterations})`,
        });
        this.setState("paused");
        break;
      }

      this.emit({ type: "phase:scanning", timestamp: Date.now() });
      const taskFile = await loadTasks(this.sessionPaths.tasks);

      if (allTasksDone(taskFile)) {
        this.emit({ type: "complete" });
        this.setState("completed");
        break;
      }

      const trace = globalTrace();
      trace.startPhase("engine:task-selection");
      const task = selectNextTask(taskFile);
      trace.endPhase("engine:task-selection");
      if (!task) {
        this.setState("blocked");
        this.emit({
          type: "state:change",
          message: "No available tasks (dependency deadlock or all failed)",
        });
        break;
      }

      this.iteration++;
      this.emit({
        type: "iteration:start",
        iteration: this.iteration,
        taskId: task.id,
      });
      this.emit({ type: "task:start", taskId: task.id, message: task.title });

      await persistTaskStatus(this.sessionPaths, task.id, "in_progress");

      this.emit({ type: "phase:building-prompt", timestamp: Date.now() });
      trace.startPhase("build:read-files");
      const promptContext = await this.loadPromptContext("build:read-files");
      trace.endPhase("build:read-files");
      trace.startPhase("engine:prompt-build");
      if (this.sessionSlug === null) {
        this.sessionSlug = await getSessionSlug(this.sessionPaths);
      }
      const prompt = await buildPrompt(
        task,
        this.sessionPaths,
        this.cwd,
        this.iteration,
        this.config.agent.name,
        this.sessionSlug,
        this.config.template?.path,
        "execute",
        promptContext,
      );
      trace.endPhase("engine:prompt-build");

      // Execute agent
      this.emit({ type: "phase:spawning-agent", timestamp: Date.now() });
      trace.startPhase("engine:agent-execution");
      const startTime = Date.now();
      let output = "";
      let firstChunkReceived = false;
      const emitToolLogs = this.config.tui?.show_tool_logs !== false;
      const currentAgent =
        this.rateLimitAttempts > 0 && this.fallbackAgent
          ? this.fallbackAgent
          : this.agent;

      const handle = currentAgent.execute(prompt, {
        cwd: this.cwd,
        timeout: this.config.agent.timeout,
        model: this.config.agent.model,
        skipPermissions: this.config.agent.skip_permissions,
        onStdout: (chunk) => {
          const isFirst = !firstChunkReceived;
          if (isFirst) {
            firstChunkReceived = true;
          }

          const markers = parseAcDoneMarkers(chunk);
          for (const oneBasedIdx of markers) {
            const zeroBasedIdx = oneBasedIdx - 1;
            if (
              task.criteriaCompleted &&
              zeroBasedIdx >= 0 &&
              zeroBasedIdx < task.criteriaCompleted.length
            ) {
              task.criteriaCompleted[zeroBasedIdx] = true;
              this.emit({
                type: "ac:criteria-met",
                taskId: task.id,
                criterionIndex: zeroBasedIdx,
              });
            }
          }

          const stripped = stripAcDoneMarkers(chunk);
          output += stripped;
          const display = stripped.includes("<promise>") ? stripped.replace(COMPLETION_PATTERN, "") : stripped;
          this.emit({ type: "agent:stdout", message: display, taskId: task.id, isFirstChunk: isFirst });
        },
        onStderr: (chunk) => {
          this.emit({ type: "agent:stderr", message: chunk, taskId: task.id });
        },
        onTool: emitToolLogs
          ? (event) => {
            this.emit({ type: "agent:tool", taskId: task.id, tool: event });
          }
          : undefined,
      });

      this.activeInterrupt = () => handle.interrupt();
      this.emit({ type: "phase:waiting-response", timestamp: Date.now() });
      const result = await handle.promise;
      this.activeInterrupt = null;
      trace.endPhase("engine:agent-execution");
      const duration = Date.now() - startTime;

      if (this.shouldStop) break;

      const logPath = `${this.sessionPaths.logs}/iteration-${String(this.iteration).padStart(3, "0")}.jsonl`;
      await ensureDir(this.sessionPaths.logs);
      await writeText(logPath, output);

      // Result processing
      trace.startPhase("engine:result-processing");

      const { rateLimited, delay } = await this.handleRateLimit(task.id, result);
      if (rateLimited) {
        trace.endPhase("engine:result-processing");
        await Bun.sleep(delay);
        continue;
      }

      const completionDetected = COMPLETION_PATTERN.test(output);
      const backpressurePassed = await this.runBackpressureChecks(task.id);
      const success =
        result.exitCode === 0 && backpressurePassed && !result.timedOut;

      const freshTaskFile = await loadTasks(this.sessionPaths.tasks);

      if (success) {
        await this.handleIterationSuccess(task, freshTaskFile, duration);
      } else {
        const tripped = await this.handleIterationFailure(
          task,
          freshTaskFile,
          result,
          backpressurePassed,
        );
        if (tripped) break;
      }

      // Check completion immediately after task status update — before autoCommit
      // so git hooks can never block the transition to review/finalize.
      const finalTasks = await loadTasks(this.sessionPaths.tasks);
      const done = allTasksDone(finalTasks);

      if (success && this.config.execution.auto_commit) {
        if (done) {
          // Await with timeout: let autoCommit finish but don't block indefinitely
          await Promise.race([this.autoCommit(task).catch((err) => this.emit({ type: "task:failed", taskId: task.id, message: `autoCommit failed: ${err?.message ?? err}` })), new Promise(resolve => setTimeout(resolve, 5000))]);
        } else {
          await this.autoCommit(task);
        }
      }

      trace.endPhase("engine:result-processing");

      if (done) {
        this.emit({ type: "complete" });
        this.setState("completed");
        break;
      }

      try {
        await updateRun(this.sessionPaths, { currentIteration: this.iteration });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit({
          type: "state:change",
          message: `Failed to update run: ${message}`,
        });
      }

      if (result.firstTokenMs !== undefined && result.firstTokenMs !== null) {
        trace.recordPhase("engine:first-token", result.firstTokenMs);
      }

      const tokenUsage = parseTokenUsageFromOutput(result.rawStdout ?? output);
      const iterResult: IterationResult = {
        iteration: this.iteration,
        taskId: task.id,
        success,
        backpressurePassed,
        completionDetected,
        output: output.slice(0, 5000),
        duration,
        tokenUsage: tokenUsage
          ? { inputTokens: tokenUsage.inputTokens, outputTokens: tokenUsage.outputTokens }
          : undefined,
      };

      this.emit({
        type: "iteration:end",
        iteration: this.iteration,
        taskId: task.id,
        data: iterResult,
      });

      if (this.config.execution.iteration_delay > 0) {
        await Bun.sleep(this.config.execution.iteration_delay);
      }
    }
  }
}
