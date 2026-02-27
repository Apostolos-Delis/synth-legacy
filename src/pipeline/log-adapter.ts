import type { PipelineEmitter, PipelineEvent } from "./types.js";
import type { EngineEvent } from "../engine/types.js";
import type { ParallelEvent } from "../parallel/events.js";
import { fmt } from "../tui/theme.js";
import { formatToolEvent } from "../utils/tool-format.js";
import { log, logError, logSuccess, printCompletionSummary } from "../commands/helpers.js";

export interface LogAdapterOptions {
  showToolLogs?: boolean;
}

export class LogAdapter {
  private unsubscribe: (() => void) | null = null;
  private readonly pipeline: PipelineEmitter;
  private readonly showToolLogs: boolean;

  constructor(pipeline: PipelineEmitter, options?: LogAdapterOptions) {
    this.pipeline = pipeline;
    this.showToolLogs = options?.showToolLogs !== false;
    this.unsubscribe = pipeline.on(this.handleEvent);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // ---------------------------------------------------------------------------
  // Top-level pipeline event router
  // ---------------------------------------------------------------------------

  private handleEvent = (event: PipelineEvent): void => {
    switch (event.type) {
      case "engine:event":
        this.handleEngineEvent(event.event);
        break;
      case "parallel:event":
        this.handleParallelEvent(event.event);
        break;
      case "summary:ready":
        printCompletionSummary(event.summary);
        this.promptCreatePr();
        break;
      case "review:status-changed":
        this.handleReviewStatus(event);
        break;
      case "error":
        logError(`[${event.phase}] ${event.error.message}`);
        break;
      case "log":
        this.handleLog(event);
        break;
    }
  };

  // ---------------------------------------------------------------------------
  // Serial engine events — mirrors run.tsx lines 739-773
  // ---------------------------------------------------------------------------

  private handleEngineEvent(event: EngineEvent): void {
    switch (event.type) {
      case "iteration:start":
        log(
          `\n${fmt.bold(`━━━ Iteration ${event.iteration} ━━━`)} ${fmt.label("task:", event.taskId ?? "")}`,
        );
        break;
      case "task:complete":
        logSuccess(`  ${event.taskId}: ${event.message}`);
        break;
      case "task:failed":
        logError(`  ${event.taskId}: ${event.message}`);
        break;
      case "backpressure:pass":
        logSuccess("  backpressure passed");
        break;
      case "backpressure:fail":
        logError(`  backpressure failed: ${event.message}`);
        break;
      case "circuit:trip":
        logError(`Circuit breaker: ${event.message}`);
        break;
      case "rate-limit:detected":
        log(`  ${fmt.warn(event.message ?? "Rate limited")}`);
        break;
      case "agent:stdout":
        if (event.message) process.stdout.write(event.message);
        break;
      case "agent:tool":
        if (this.showToolLogs && event.tool) log(formatToolEvent(event.tool));
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Parallel coordinator events — mirrors run.tsx lines 392-431
  // ---------------------------------------------------------------------------

  private handleParallelEvent(event: ParallelEvent): void {
    switch (event.type) {
      case "parallel:started":
        log(fmt.info("Parallel execution started"));
        break;
      case "parallel:group-started":
        log(fmt.info("Starting wave"));
        break;
      case "worker:started":
        log(fmt.info(`Worker ${event.workerId} started`));
        break;
      case "worker:completed":
        logSuccess(`Worker ${event.workerId} completed`);
        break;
      case "worker:failed":
        logError(`Worker ${event.workerId} failed`);
        break;
      case "merge:completed":
        logSuccess(`Merged task ${event.taskId}`);
        break;
      case "merge:failed":
        logError(`Merge failed for task ${event.taskId}${event.reason ? `: ${event.reason}` : ""}`);
        break;
      case "merge:skipped":
        log(fmt.warn(`Merge skipped for task ${event.taskId}: ${event.reason}`));
        break;
      case "conflict:detected":
        log(fmt.warn("Merge conflict detected"));
        break;
      case "parallel:completed":
        logSuccess("Parallel execution completed");
        break;
      case "parallel:warning":
        log(fmt.warn(event.message));
        break;
      case "parallel:failed":
        logError("Parallel execution failed");
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Review phase — mirrors run.tsx lines 928-949
  // ---------------------------------------------------------------------------

  private handleReviewStatus(event: PipelineEvent & { type: "review:status-changed" }): void {
    switch (event.status) {
      case "running":
        log(`\n${fmt.bold("━━━ Review Phase ━━━")}`);
        log(fmt.info("Analyzing execution output for issues..."));
        break;
      case "complete":
        log(fmt.info("Review completed"));
        break;
      case "error":
        logError(`Review failed${event.error ? `: ${event.error}` : ""}`);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Generic log events
  // ---------------------------------------------------------------------------

  private handleLog(event: PipelineEvent & { type: "log" }): void {
    switch (event.level) {
      case "error":
        logError(event.message);
        break;
      case "warn":
        log(fmt.warn(event.message));
        break;
      case "info":
        log(fmt.info(event.message));
        break;
      case "debug":
        log(fmt.dim(event.message));
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Create PR? prompt — mirrors run.tsx lines 961-969
  // ---------------------------------------------------------------------------

  private async promptCreatePr(): Promise<void> {
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`\nCreate PR? (Y/n) `, resolve);
    });
    rl.close();

    const accepted = !answer || answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
    this.pipeline.submitAction({
      requestId: "finalize",
      key: accepted ? "create-pr" : "skip",
    });
  }
}
