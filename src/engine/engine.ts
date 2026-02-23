import type { SynthConfig } from "../config/types.js";
import type { AgentAdapter } from "../agents/types.js";
import type { PlanPaths } from "../plans/types.js";
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
import { loadTasks, saveTasks, updateTaskStatus, allTasksDone } from "../tasks/store.js";
import { selectNextTask } from "../tasks/selector.js";
import { buildPrompt } from "../prompts/build.js";
import { appendText, writeText, ensureDir } from "../utils/fs.js";
import { spawn } from "../utils/process.js";
import { updateSession } from "../session/session.js";
import { globalTrace } from "../utils/perf.js";

const COMPLETION_PATTERN = /<promise>COMPLETE<\/promise>/;

export class Engine {
  private state: EngineState = "idle";
  private iteration = 0;
  private shouldStop = false;
  private rateLimitAttempts = 0;
  private listeners: EngineEventListener[] = [];
  private circuitBreaker: CircuitBreaker;
  private activeInterrupt: (() => void) | null = null;

  constructor(
    private config: SynthConfig,
    private agent: AgentAdapter,
    private fallbackAgent: AgentAdapter | null,
    private planPaths: PlanPaths,
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

  pause(): void {
    this.shouldStop = true;
    this.setState("paused");
  }

  stop(): void {
    this.shouldStop = true;
    this.activeInterrupt?.();
  }

  async run(startIteration = 0): Promise<void> {
    this.iteration = startIteration;
    this.shouldStop = false;
    this.setState("executing");

    while (!this.shouldStop) {
      // Check iteration cap
      if (this.iteration >= this.config.execution.max_iterations) {
        this.emit({
          type: "state:change",
          message: `Reached max iterations (${this.config.execution.max_iterations})`,
        });
        this.setState("paused");
        break;
      }

      // Load tasks fresh each iteration
      this.emit({ type: "phase:scanning", timestamp: Date.now() });
      const taskFile = await loadTasks(this.planPaths.tasks);

      // Check all done
      if (allTasksDone(taskFile)) {
        this.emit({ type: "complete" });
        this.setState("completed");
        break;
      }

      // Select next task
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

      // Mark in_progress
      const updatedFile = updateTaskStatus(taskFile, task.id, "in_progress");
      await saveTasks(this.planPaths.tasks, updatedFile);

      // Build prompt
      this.emit({ type: "phase:building-prompt", timestamp: Date.now() });
      trace.startPhase("engine:prompt-build");
      const prompt = await buildPrompt(
        task,
        this.planPaths,
        this.cwd,
        this.iteration,
      );
      trace.endPhase("engine:prompt-build");

      // Execute agent
      this.emit({ type: "phase:spawning-agent", timestamp: Date.now() });
      trace.startPhase("engine:agent-execution");
      const startTime = Date.now();
      let output = "";
      let firstChunkReceived = false;
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

          // Parse ac-done markers before appending to output
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
          this.emit({ type: "agent:stdout", message: stripped, taskId: task.id, isFirstChunk: isFirst });
        },
        onStderr: (chunk) => {
          this.emit({ type: "agent:stderr", message: chunk, taskId: task.id });
        },
      });

      this.activeInterrupt = () => handle.interrupt();
      this.emit({ type: "phase:waiting-response", timestamp: Date.now() });
      const result = await handle.promise;
      this.activeInterrupt = null;
      trace.endPhase("engine:agent-execution");
      const duration = Date.now() - startTime;

      if (this.shouldStop) break;

      // Log iteration
      const logPath = `${this.planPaths.logs}/iteration-${String(this.iteration).padStart(3, "0")}.jsonl`;
      await ensureDir(this.planPaths.logs);
      await writeText(logPath, output);

      // Result processing
      trace.startPhase("engine:result-processing");

      // Rate limit check
      if (detectRateLimit(result.stdout + result.stderr)) {
        this.rateLimitAttempts++;
        const delay = getBackoffDelay(this.rateLimitAttempts);
        this.emit({
          type: "rate-limit:detected",
          message: `Rate limited, backing off ${delay / 1000}s`,
        });
        // Re-read tasks.json and revert to open (prevents overwriting external changes)
        const freshFile = await loadTasks(this.planPaths.tasks);
        const reverted = updateTaskStatus(freshFile, task.id, "open");
        await saveTasks(this.planPaths.tasks, reverted);
        trace.endPhase("engine:result-processing");
        await Bun.sleep(delay);
        continue;
      }
      this.rateLimitAttempts = 0;

      // Completion detection
      const completionDetected = COMPLETION_PATTERN.test(output);

      // Backpressure
      let backpressurePassed = true;
      if (this.config.guardrails.backpressure_commands.length > 0) {
        this.emit({ type: "backpressure:start", taskId: task.id });
        const bp = await runBackpressure(
          this.config.guardrails.backpressure_commands,
          this.cwd,
        );
        backpressurePassed = bp.passed;

        if (bp.passed) {
          this.emit({ type: "backpressure:pass", taskId: task.id });
        } else {
          this.emit({
            type: "backpressure:fail",
            taskId: task.id,
            message: bp.results
              .filter((r) => r.exitCode !== 0)
              .map((r) => `${r.command}: exit ${r.exitCode}`)
              .join(", "),
          });
        }
      }

      // Determine success
      const success =
        result.exitCode === 0 && backpressurePassed && !result.timedOut;

      // Re-read tasks.json before writing final status (prevents overwriting external changes)
      const freshTaskFile = await loadTasks(this.planPaths.tasks);

      if (success) {
        // Mark all criteria as complete on successful task completion
        if (task.criteriaCompleted) {
          for (let i = 0; i < task.criteriaCompleted.length; i++) {
            task.criteriaCompleted[i] = true;
          }
        }
        // Merge in-memory criteriaCompleted before persisting
        const mergedFile: typeof freshTaskFile = {
          ...freshTaskFile,
          tasks: freshTaskFile.tasks.map((t) =>
            t.id === task.id
              ? { ...t, criteriaCompleted: task.criteriaCompleted ?? t.criteriaCompleted }
              : t,
          ),
        };
        const doneFile = updateTaskStatus(mergedFile, task.id, "done");
        await saveTasks(this.planPaths.tasks, doneFile);
        this.circuitBreaker.recordSuccess();
        this.emit({
          type: "task:complete",
          taskId: task.id,
          message: task.title,
        });

        // Auto-commit (git add -u: only tracked files, not untracked)
        if (this.config.execution.auto_commit) {
          const commitMsg = `feat: ${task.id} - ${task.title}`;
          const addHandle = spawn({
            cmd: ["git", "add", "-u"],
            cwd: this.cwd,
          });
          await addHandle.promise;
          const commitResult = spawn({
            cmd: ["git", "commit", "-m", commitMsg, "--allow-empty"],
            cwd: this.cwd,
          });
          await commitResult.promise;
        }

        // Append progress
        const progressEntry = `## Iteration ${this.iteration} - ${task.id}: ${task.title}\n- Status: done\n- Duration: ${Math.round(duration / 1000)}s\n---\n`;
        await appendText(this.planPaths.progress, progressEntry);
      } else {
        const failNotes = !backpressurePassed
          ? `Iteration ${this.iteration}: backpressure failed`
          : result.timedOut
            ? `Iteration ${this.iteration}: timed out`
            : `Iteration ${this.iteration}: agent exited with code ${result.exitCode}`;

        // Merge any criteria progress observed during this iteration
        const mergedFailFile: typeof freshTaskFile = {
          ...freshTaskFile,
          tasks: freshTaskFile.tasks.map((t) =>
            t.id === task.id
              ? { ...t, criteriaCompleted: task.criteriaCompleted ?? t.criteriaCompleted }
              : t,
          ),
        };
        const failedFile = updateTaskStatus(
          mergedFailFile,
          task.id,
          "open",
          failNotes,
        );
        await saveTasks(this.planPaths.tasks, failedFile);
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
          break;
        }
      }

      trace.endPhase("engine:result-processing");

      // Update session with current iteration
      try {
        await updateSession(this.planPaths, { currentIteration: this.iteration });
      } catch {
        // Session may not exist in all contexts
      }

      // Store first-token timestamp for reporting
      if (result.firstTokenMs !== undefined && result.firstTokenMs !== null) {
        trace.recordPhase("engine:first-token", result.firstTokenMs);
      }

      const iterResult: IterationResult = {
        iteration: this.iteration,
        taskId: task.id,
        success,
        backpressurePassed,
        completionDetected,
        output: output.slice(0, 5000),
        duration,
      };

      this.emit({
        type: "iteration:end",
        iteration: this.iteration,
        taskId: task.id,
        data: iterResult,
      });

      // Check completion after successful iteration
      if (completionDetected) {
        const finalTasks = await loadTasks(this.planPaths.tasks);
        if (allTasksDone(finalTasks)) {
          this.emit({ type: "complete" });
          this.setState("completed");
          break;
        }
      }

      // Iteration delay
      if (this.config.execution.iteration_delay > 0) {
        await Bun.sleep(this.config.execution.iteration_delay);
      }
    }
  }
}
