import { join } from "node:path";
import { mkdir, copyFile } from "node:fs/promises";
import type { SynthConfig } from "../config/types.js";
import type { AgentAdapter } from "../agents/types.js";
import type { SessionPaths } from "../sessions/types.js";
import type { Task } from "../tasks/types.js";
import type { EngineEvent, EngineEventListener } from "../engine/types.js";
import type { WorkerResult } from "./merge-engine.js";
import type { ParallelEventListener, ParallelEvent } from "./events.js";
import { Engine } from "../engine/engine.js";
import { saveTasks } from "../tasks/store.js";
import { stripAnsi } from "../tui/utils.js";

export type WorkerStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkerConfig {
  id: string;
  task: Task;
  worktreePath: string;
  branchName: string;
}

export interface WorkerDisplayState {
  id: string;
  status: WorkerStatus;
  task: Task;
  currentIteration: number;
  maxIterations: number;
  lastOutput: string;
  elapsedMs: number;
  worktreePath: string;
  branchName: string;
}

export class Worker {
  readonly id: string;
  readonly config: WorkerConfig;

  private engine: Engine | null = null;
  private status: WorkerStatus = "idle";
  private startTime = 0;
  private currentIteration = 0;
  private maxIterations: number;
  private lastOutput = "";
  private commitCount = 0;
  private readonly listeners: ParallelEventListener[] = [];
  private readonly engineListeners: EngineEventListener[] = [];

  constructor(
    config: WorkerConfig,
    private readonly synthConfig: SynthConfig,
    private readonly agent: AgentAdapter,
    private readonly fallbackAgent: AgentAdapter | null,
    private readonly baseSessionPaths: SessionPaths,
  ) {
    this.id = config.id;
    this.config = config;
    this.maxIterations = synthConfig.execution.max_iterations;
  }

  on(listener: ParallelEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  onEngineEvent(listener: EngineEventListener): () => void {
    this.engineListeners.push(listener);
    return () => {
      const idx = this.engineListeners.indexOf(listener);
      if (idx >= 0) this.engineListeners.splice(idx, 1);
    };
  }

  async start(): Promise<WorkerResult> {
    this.status = "running";
    this.startTime = Date.now();
    this.commitCount = 0;

    const workerSessionPaths = this.createWorkerSessionPaths();
    await this.prepareWorkerSession(workerSessionPaths);

    const workerConfig: SynthConfig = {
      ...this.synthConfig,
      execution: {
        ...this.synthConfig.execution,
        auto_commit: true,
      },
    };

    this.engine = new Engine(
      workerConfig,
      this.agent,
      this.fallbackAgent,
      workerSessionPaths,
      this.config.worktreePath,
    );

    this.engine.on((event) => {
      this.handleEngineEvent(event);
    });

    this.emitParallel({
      type: "worker:started",
      timestamp: new Date().toISOString(),
      workerId: this.id,
    });

    try {
      await this.engine.run();

      if (this.getStatus() === "cancelled") {
        const result: WorkerResult = {
          workerId: this.id,
          taskId: this.config.task.id,
          taskTitle: this.config.task.title,
          branch: this.config.branchName,
          success: false,
          iterationsRun: this.currentIteration,
          durationMs: Date.now() - this.startTime,
          commitCount: this.commitCount,
          worktreePath: this.config.worktreePath,
          error: "Worker was cancelled",
        };

        this.emitParallel({
          type: "worker:failed",
          timestamp: new Date().toISOString(),
          workerId: this.id,
        });

        return result;
      }

      this.status = "completed";

      const result: WorkerResult = {
        workerId: this.id,
        taskId: this.config.task.id,
        taskTitle: this.config.task.title,
        branch: this.config.branchName,
        success: true,
        iterationsRun: this.currentIteration,
        durationMs: Date.now() - this.startTime,
        commitCount: this.commitCount,
        worktreePath: this.config.worktreePath,
      };

      this.emitParallel({
        type: "worker:completed",
        timestamp: new Date().toISOString(),
        workerId: this.id,
      });

      return result;
    } catch (err) {
      this.status = "failed";
      const error = err instanceof Error ? err.message : String(err);

      const result: WorkerResult = {
        workerId: this.id,
        taskId: this.config.task.id,
        taskTitle: this.config.task.title,
        branch: this.config.branchName,
        success: false,
        iterationsRun: this.currentIteration,
        durationMs: Date.now() - this.startTime,
        commitCount: this.commitCount,
        worktreePath: this.config.worktreePath,
        error,
      };

      this.emitParallel({
        type: "worker:failed",
        timestamp: new Date().toISOString(),
        workerId: this.id,
      });

      return result;
    }
  }

  stop(): void {
    this.status = "cancelled";
    if (this.engine) {
      this.engine.stop();
    }
  }

  getDisplayState(): WorkerDisplayState {
    return {
      id: this.id,
      status: this.status,
      task: this.config.task,
      currentIteration: this.currentIteration,
      maxIterations: this.maxIterations,
      lastOutput: this.lastOutput,
      elapsedMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
      worktreePath: this.config.worktreePath,
      branchName: this.config.branchName,
    };
  }

  getStatus(): WorkerStatus {
    return this.status;
  }

  getTask(): Task {
    return this.config.task;
  }

  private createWorkerSessionPaths(): SessionPaths {
    const root = join(this.config.worktreePath, ".synth-session");
    return {
      root,
      prd: join(root, "prd.md"),
      tasks: join(root, "tasks.json"),
      progress: join(root, "progress.json"),
      run: join(root, "run.json"),
      lock: join(root, "lock"),
      logs: join(root, "logs"),
      summary: join(root, "summary.md"),
      interview: join(root, "interview.json"),
      reviewRoot: join(root, "review"),
      reviewFindings: join(root, "review", "findings.json"),
      reviewTasks: join(root, "review", "tasks.json"),
      reviewProgress: join(root, "review", "progress.json"),
      reviewConversation: join(root, "review", "conversation.json"),
    };
  }

  private async prepareWorkerSession(
    workerSessionPaths: SessionPaths,
  ): Promise<void> {
    await mkdir(workerSessionPaths.root, { recursive: true });
    await mkdir(workerSessionPaths.logs, { recursive: true });
    await mkdir(workerSessionPaths.reviewRoot, { recursive: true });

    const task = this.config.task;
    const taskFile = {
      project: this.synthConfig.project.name,
      branchName: this.config.branchName,
      description: `Worker ${this.id}: ${task.title}`,
      // Coordinator handles dependency ordering via wave grouping; clear for single-task engine
      tasks: [{ ...task, status: "open" as const, dependsOn: [] }],
    };
    await saveTasks(workerSessionPaths.tasks, taskFile);

    try {
      await copyFile(this.baseSessionPaths.prd, workerSessionPaths.prd);
    } catch {
      // PRD may not exist — that's fine
    }
  }

  private handleEngineEvent(event: EngineEvent): void {
    switch (event.type) {
      case "iteration:start":
        this.currentIteration = event.iteration ?? this.currentIteration + 1;
        this.emitParallel({
          type: "worker:progress",
          timestamp: new Date().toISOString(),
          workerId: this.id,
          iteration: this.currentIteration,
          maxIterations: this.maxIterations,
          elapsedMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
          status: this.status,
        });
        break;
      case "agent:stdout":
        if (typeof event.message === "string" && event.message.trim()) {
          this.lastOutput = stripAnsi(event.message).trim().slice(-200);
          this.emitParallel({
            type: "worker:output",
            timestamp: new Date().toISOString(),
            workerId: this.id,
            message: event.message,
            taskId: this.config.task.id,
          });
        }
        break;
      case "task:complete":
        this.commitCount++;
        break;
    }

    for (const listener of this.engineListeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break the worker
      }
    }
  }

  private emitParallel(event: ParallelEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break the worker
      }
    }
  }
}
