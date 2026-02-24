import { randomUUID } from "node:crypto";
import type { Task } from "../tasks/types.js";
import type { SessionPaths } from "../sessions/types.js";
import type { ParallelEvent, ParallelEventListener } from "./events.js";
import type { WorktreeInfo } from "./worktree-manager.js";
import type { WorkerResult, MergeOperation } from "./merge-engine.js";
import { analyzeTaskGraph, type TaskGraphAnalysis } from "./task-graph.js";
import { WorktreeManager } from "./worktree-manager.js";
import { MergeEngine } from "./merge-engine.js";
import {
  saveParallelSession,
  deleteParallelSession,
  type ParallelSessionState,
} from "./session.js";
import {
  getCurrentBranch,
  checkoutBranch,
  createTag,
  deleteTag,
  mergeFF,
} from "../utils/git.js";

export interface ParallelCoordinatorConfig {
  maxWorkers?: number;
  aiConflictResolution?: boolean;
  maxRequeueCount?: number;
}

export interface WorkerExecutor {
  execute(task: Task, worktree: WorktreeInfo): Promise<WorkerResult>;
}

export interface ParallelCoordinatorOptions {
  tasks: Task[];
  repoRoot: string;
  project: string;
  sessionPaths: SessionPaths;
  config?: ParallelCoordinatorConfig;
  executor: WorkerExecutor;
}

export interface ParallelResult {
  mergedTaskIds: string[];
  failedTaskIds: string[];
  serial: boolean;
}

export class ParallelCoordinator {
  private readonly maxWorkers: number;
  private readonly aiConflictResolution: boolean;
  private readonly maxRequeueCount: number;
  private readonly tasks: Task[];
  private readonly repoRoot: string;
  private readonly project: string;
  private readonly sessionPaths: SessionPaths;
  private readonly executor: WorkerExecutor;
  private readonly listeners: ParallelEventListener[] = [];

  private worktreeManager: WorktreeManager | null = null;
  private mergeEngine: MergeEngine | null = null;
  private analysis: TaskGraphAnalysis | null = null;
  private originalBranch: string | null = null;
  private sessionBranch: string | null = null;
  private sessionStartTag: string | null = null;
  private aborted = false;
  private requeueCounts = new Map<string, number>();

  constructor(options: ParallelCoordinatorOptions) {
    const config = options.config ?? {};
    this.maxWorkers = config.maxWorkers ?? 8;
    this.aiConflictResolution = config.aiConflictResolution ?? true;
    this.maxRequeueCount = config.maxRequeueCount ?? 1;
    this.tasks = options.tasks;
    this.repoRoot = options.repoRoot;
    this.project = options.project;
    this.sessionPaths = options.sessionPaths;
    this.executor = options.executor;
  }

  on(listener: ParallelEventListener): void {
    this.listeners.push(listener);
  }

  private emit(event: ParallelEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private timestamp(): string {
    return new Date().toISOString();
  }

  async run(): Promise<ParallelResult> {
    this.analysis = analyzeTaskGraph(this.tasks);

    if (!this.analysis.recommendParallel) {
      return { mergedTaskIds: [], failedTaskIds: [], serial: true };
    }

    this.emit({ type: "parallel:started", timestamp: this.timestamp() });

    this.originalBranch = await getCurrentBranch(this.repoRoot);
    this.mergeEngine = new MergeEngine({ repoRoot: this.repoRoot });
    const sessionId = randomUUID();
    this.sessionBranch = await this.mergeEngine.initializeSessionBranch(sessionId);

    this.sessionStartTag = `synth/session-start/${sessionId.slice(0, 8)}`;
    await createTag(this.sessionStartTag, this.repoRoot);

    this.worktreeManager = new WorktreeManager({
      repoRoot: this.repoRoot,
      project: this.project,
      maxWorktrees: this.maxWorkers,
    });

    const mergedTaskIds: string[] = [];
    const failedTaskIds: string[] = [];

    await this.persistState(mergedTaskIds, failedTaskIds, -1);

    const taskMap = new Map(this.tasks.map((t) => [t.id, t]));

    try {
      for (let gi = 0; gi < this.analysis.groups.length; gi++) {
        if (this.aborted) break;

        const group = this.analysis.groups[gi];
        this.emit({ type: "parallel:group-started", timestamp: this.timestamp() });

        const effectiveWorkers = Math.min(group.taskIds.length, this.maxWorkers);
        const groupTasks = group.taskIds
          .map((id) => taskMap.get(id))
          .filter((t): t is Task => t !== undefined);

        const results = await this.executeWave(groupTasks, effectiveWorkers);

        for (const result of results) {
          if (this.aborted) break;

          const op = this.mergeEngine!.enqueue(result);
          this.emit({
            type: "merge:queued",
            timestamp: this.timestamp(),
            operationId: op.id,
            taskId: result.taskId,
          });

          const processed = await this.mergeEngine!.processNext();
          if (!processed) continue;

          this.emit({
            type: "merge:started",
            timestamp: this.timestamp(),
            operationId: processed.id,
            taskId: processed.taskId,
          });

          if (processed.status === "completed") {
            mergedTaskIds.push(processed.taskId);
            this.emit({
              type: "merge:completed",
              timestamp: this.timestamp(),
              operationId: processed.id,
              taskId: processed.taskId,
            });
          } else if (processed.status === "conflicted") {
            this.emit({ type: "conflict:detected", timestamp: this.timestamp() });

            if (this.aiConflictResolution) {
              this.emit({ type: "conflict:ai-resolving", timestamp: this.timestamp() });
              // AI resolution not implemented in coordinator — treat as failed
              const resolved = false;
              if (resolved) {
                this.emit({ type: "conflict:resolved", timestamp: this.timestamp() });
                mergedTaskIds.push(processed.taskId);
              } else {
                this.handleFailedMerge(processed, failedTaskIds);
              }
            } else {
              this.handleFailedMerge(processed, failedTaskIds);
            }
          } else {
            this.emit({
              type: "merge:failed",
              timestamp: this.timestamp(),
              operationId: processed.id,
              taskId: processed.taskId,
            });
            failedTaskIds.push(processed.taskId);
          }
        }

        await this.worktreeManager!.cleanupAll();
        await this.persistState(mergedTaskIds, failedTaskIds, gi);

        this.emit({ type: "parallel:group-completed", timestamp: this.timestamp() });
      }

      // Merge session branch back to original branch
      if (this.originalBranch && this.sessionBranch) {
        await checkoutBranch(this.originalBranch, this.repoRoot);
        try {
          await mergeFF(this.sessionBranch, this.repoRoot);
        } catch {
          // If FF fails, the session branch has diverged — leave on original
        }
      }

      await this.cleanup();

      this.emit({ type: "parallel:completed", timestamp: this.timestamp() });

      return { mergedTaskIds, failedTaskIds, serial: false };
    } catch (error) {
      this.emit({ type: "parallel:failed", timestamp: this.timestamp() });
      await this.handleAbort();
      throw error;
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
    await this.handleAbort();
  }

  private handleFailedMerge(
    operation: MergeOperation,
    failedTaskIds: string[],
  ): void {
    const count = this.requeueCounts.get(operation.taskId) ?? 0;
    if (count < this.maxRequeueCount) {
      this.requeueCounts.set(operation.taskId, count + 1);
      // Task is re-queued — don't add to failedTaskIds
    } else {
      failedTaskIds.push(operation.taskId);
      this.emit({
        type: "merge:failed",
        timestamp: this.timestamp(),
        operationId: operation.id,
        taskId: operation.taskId,
      });
    }
  }

  private async executeWave(
    tasks: Task[],
    effectiveWorkers: number,
  ): Promise<WorkerResult[]> {
    const results: WorkerResult[] = [];
    const batches: Task[][] = [];

    for (let i = 0; i < tasks.length; i += effectiveWorkers) {
      batches.push(tasks.slice(i, i + effectiveWorkers));
    }

    for (const batch of batches) {
      if (this.aborted) break;

      const promises = batch.map(async (task, idx) => {
        const workerId = `w-${task.id}-${idx}`;

        this.emit({
          type: "worker:created",
          timestamp: this.timestamp(),
          workerId,
        });

        const worktree = await this.worktreeManager!.acquire(
          workerId,
          task.id,
          this.sessionBranch!,
        );

        this.emit({
          type: "worker:started",
          timestamp: this.timestamp(),
          workerId,
        });

        try {
          const result = await this.executor.execute(task, worktree);
          this.emit({
            type: "worker:completed",
            timestamp: this.timestamp(),
            workerId,
          });
          return result;
        } catch {
          this.emit({
            type: "worker:failed",
            timestamp: this.timestamp(),
            workerId,
          });
          return null;
        }
      });

      const batchResults = await Promise.all(promises);
      for (const r of batchResults) {
        if (r) results.push(r);
      }
    }

    return results;
  }

  private async handleAbort(): Promise<void> {
    if (this.worktreeManager) {
      await this.worktreeManager.cleanupAll();
    }
    if (this.originalBranch) {
      try {
        await checkoutBranch(this.originalBranch, this.repoRoot);
      } catch {
        // Best effort
      }
    }
  }

  private async cleanup(): Promise<void> {
    if (this.sessionStartTag) {
      try {
        await deleteTag(this.sessionStartTag, this.repoRoot);
      } catch {
        // Tag may already be deleted
      }
    }
    try {
      await deleteParallelSession(this.sessionPaths);
    } catch {
      // Session file may not exist
    }
  }

  private async persistState(
    mergedTaskIds: string[],
    failedTaskIds: string[],
    lastCompletedGroupIndex: number,
  ): Promise<void> {
    if (!this.analysis || !this.sessionBranch || !this.originalBranch || !this.sessionStartTag) return;

    const state: ParallelSessionState = {
      sessionId: this.sessionBranch,
      taskGraph: {
        groups: this.analysis.groups,
        cyclicTaskIds: this.analysis.cyclicTaskIds,
        maxParallelism: this.analysis.maxParallelism,
        recommendParallel: this.analysis.recommendParallel,
        nodes: [...this.analysis.nodes.entries()],
      },
      lastCompletedGroupIndex,
      mergedTaskIds,
      failedTaskIds,
      requeuedTaskIds: [...this.requeueCounts.keys()],
      sessionStartTag: this.sessionStartTag,
      sessionBranch: this.sessionBranch,
      originalBranch: this.originalBranch,
    };

    await saveParallelSession(this.sessionPaths, state);
  }
}
