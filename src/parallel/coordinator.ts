import { randomUUID } from "node:crypto";
import type { Task } from "../tasks/types.js";
import type { SynthConfig } from "../config/types.js";
import type { AgentAdapter } from "../agents/types.js";
import type { SessionPaths } from "../sessions/types.js";
import type { ParallelEvent, ParallelEventListener } from "./events.js";
import type { WorkerResult, MergeOperation } from "./merge-engine.js";
import { analyzeTaskGraph, type TaskGraphAnalysis } from "./task-graph.js";
import { WorktreeManager } from "./worktree-manager.js";
import { MergeEngine } from "./merge-engine.js";
import { Worker, type WorkerDisplayState } from "./worker.js";
import {
  saveParallelSession,
  deleteParallelSession,
  cleanupStaleParallelState,
  reconcileTasksFromGitLog,
  type ParallelSessionState,
} from "./session.js";
import { persistTaskStatus } from "../tasks/store.js";
import {
  getCurrentBranch,
  checkoutBranch,
  createTag,
  deleteTag,
  mergeFF,
  gitLog,
} from "../utils/git.js";
import { fileExists, readText } from "../utils/fs.js";
import { resolveConflicts, type ConflictResolutionContext } from "./conflict-resolver.js";
import { ResourceMonitor } from "./resource-monitor.js";
import { spawn } from "../utils/process.js";
import { getLogger } from "../logging/logger.js";

export interface ParallelCoordinatorConfig {
  maxWorkers?: number;
  aiConflictResolution?: boolean;
  maxRequeueCount?: number;
  staggerDelayMs?: number;
}

export interface ParallelCoordinatorOptions {
  tasks: Task[];
  repoRoot: string;
  project: string;
  sessionPaths: SessionPaths;
  config?: ParallelCoordinatorConfig;
  synthConfig: SynthConfig;
  agent: AgentAdapter;
  fallbackAgent: AgentAdapter | null;
}

export interface ParallelResult {
  mergedTaskIds: string[];
  failedTaskIds: string[];
  serial: boolean;
  error?: string;
}

export class ParallelCoordinator {
  private readonly maxWorkers: number;
  private readonly aiConflictResolution: boolean;
  private readonly maxRequeueCount: number;
  private readonly staggerDelayMs: number;
  private readonly tasks: Task[];
  private readonly repoRoot: string;
  private readonly project: string;
  private readonly sessionPaths: SessionPaths;
  private readonly synthConfig: SynthConfig;
  private readonly agent: AgentAdapter;
  private readonly fallbackAgent: AgentAdapter | null;
  private readonly listeners: ParallelEventListener[] = [];
  private readonly resourceMonitor: ResourceMonitor;
  private statusWriteChain: Promise<void> = Promise.resolve();

  private worktreeManager: WorktreeManager | null = null;
  private mergeEngine: MergeEngine | null = null;
  private analysis: TaskGraphAnalysis | null = null;
  private originalBranch: string | null = null;
  private sessionBranch: string | null = null;
  private sessionStartTag: string | null = null;
  private aborted = false;
  private interrupted = false;
  private requeueCounts = new Map<string, number>();
  private pendingRequeue = new Set<string>();
  private activeWorkers: Worker[] = [];
  private activeWorkerPromises: Promise<unknown>[] = [];
  private sigintHandler: (() => void) | null = null;
  private interruptPromise: Promise<void> | null = null;
  private interruptResolve: (() => void) | null = null;
  private static readonly GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;
  private static readonly RESOURCE_POLL_INTERVAL_MS = 2000;
  private static readonly RESOURCE_MAX_WAIT_MS = 30000;

  constructor(options: ParallelCoordinatorOptions) {
    const config = options.config ?? {};
    this.maxWorkers = config.maxWorkers ?? 8;
    this.aiConflictResolution = config.aiConflictResolution ?? true;
    this.maxRequeueCount = config.maxRequeueCount ?? 1;
    this.staggerDelayMs = config.staggerDelayMs ?? 2000;
    this.tasks = options.tasks;
    this.repoRoot = options.repoRoot;
    this.project = options.project;
    this.sessionPaths = options.sessionPaths;
    this.synthConfig = options.synthConfig;
    this.agent = options.agent;
    this.fallbackAgent = options.fallbackAgent;
    this.resourceMonitor = new ResourceMonitor();
  }

  on(listener: ParallelEventListener): void {
    this.listeners.push(listener);
  }

  getWorkerDisplayStates(): WorkerDisplayState[] {
    return this.activeWorkers.map((w) => w.getDisplayState());
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

    const log = getLogger();
    log.info("parallel:start", "Starting parallel execution", {
      workerCount: this.maxWorkers,
      taskCount: this.tasks.length,
    });

    this.emit({ type: "parallel:started", timestamp: this.timestamp(), totalGroups: this.analysis.groups.length });

    this.interruptPromise = new Promise<void>((resolve) => {
      this.interruptResolve = resolve;
    });
    this.registerSigintHandler();

    // Clean stale parallel state from previous runs/crashes
    await cleanupStaleParallelState(this.repoRoot, this.sessionPaths);

    // Reconcile tasks that were already merged in a previous run
    const reconciledIds = await reconcileTasksFromGitLog(
      this.repoRoot,
      this.sessionPaths,
      this.tasks,
    );
    const reconciledSet = new Set(reconciledIds);

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

    const mergedTaskIds: string[] = [...reconciledIds];
    const failedTaskIds: string[] = [];
    const durationByTaskId = new Map<string, number>();

    await this.persistState(mergedTaskIds, failedTaskIds, -1);

    const taskMap = new Map(this.tasks.map((t) => [t.id, t]));

    try {
      const groups = [...this.analysis.groups];

      for (let gi = 0; gi < groups.length; gi++) {
        if (this.aborted) break;

        const group = groups[gi];
        log.info("parallel:wave-start", `Starting wave ${gi + 1}/${groups.length}`, {
          wave: gi + 1,
          totalWaves: groups.length,
          taskCount: group.taskIds.length,
        });
        this.emit({ type: "parallel:group-started", timestamp: this.timestamp() });

        // Filter out tasks already completed in a previous run
        const remainingTaskIds = group.taskIds.filter((id) => !reconciledSet.has(id));
        if (remainingTaskIds.length === 0) continue;

        const effectiveWorkers = Math.min(remainingTaskIds.length, this.maxWorkers);
        const groupTasks = remainingTaskIds
          .map((id) => taskMap.get(id))
          .filter((t): t is Task => t !== undefined);

        const results = await this.executeWave(groupTasks, effectiveWorkers);

        for (const result of results) {
          if (typeof result.durationMs === "number") {
            durationByTaskId.set(result.taskId, result.durationMs);
          }
          const hasCommits = await this.branchHasNewCommits(result.branch);
          if (!hasCommits) {
            await this.queueTaskStatus(result.taskId, "failed");
            this.emit({
              type: "merge:skipped",
              timestamp: this.timestamp(),
              taskId: result.taskId,
              reason: "Worker produced no commits",
            });
            failedTaskIds.push(result.taskId);
            continue;
          }

          const op = this.mergeEngine!.enqueue(result);
          log.info("parallel:merge-queued", `Merge queued for task ${result.taskId}`, {
            taskId: result.taskId,
            operationId: op.id,
          });
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
            await this.persistTaskDone(processed.taskId, durationByTaskId.get(processed.taskId));
            this.emit({
              type: "merge:completed",
              timestamp: this.timestamp(),
              operationId: processed.id,
              taskId: processed.taskId,
            });
          } else if (processed.status === "conflicted") {
            this.emit({
              type: "conflict:detected",
              timestamp: this.timestamp(),
              taskId: processed.taskId,
              taskTitle: processed.taskTitle,
              files: processed.conflictedFiles ?? [],
            });

            if (this.aiConflictResolution) {
              this.emit({
                type: "conflict:ai-resolving",
                timestamp: this.timestamp(),
                taskId: processed.taskId,
              });

              const task = taskMap.get(processed.taskId);
              const context = await this.buildConflictContext(task, mergedTaskIds);
              const resolution = await resolveConflicts(
                processed,
                this.repoRoot,
                this.agent,
                context,
              );

              if (resolution.resolved) {
                processed.status = "completed";
                processed.error = undefined;
                this.emit({
                  type: "conflict:resolved",
                  timestamp: this.timestamp(),
                  taskId: processed.taskId,
                  resolvedCount: resolution.resolvedCount,
                  failedCount: resolution.failedCount,
                });
                mergedTaskIds.push(processed.taskId);
                await this.persistTaskDone(processed.taskId, durationByTaskId.get(processed.taskId));
                this.emit({
                  type: "merge:completed",
                  timestamp: this.timestamp(),
                  operationId: processed.id,
                  taskId: processed.taskId,
                });
              } else {
                this.handleFailedMerge(processed, failedTaskIds);
              }
            } else {
              this.handleFailedMerge(processed, failedTaskIds);
            }
          } else {
            await this.queueTaskStatus(processed.taskId, "failed");
            this.emit({
              type: "merge:failed",
              timestamp: this.timestamp(),
              operationId: processed.id,
              taskId: processed.taskId,
              reason: processed.error,
            });
            failedTaskIds.push(processed.taskId);
          }
        }

        await this.worktreeManager!.cleanupAll();

        // Inject re-queued tasks into the next wave or create a new final wave
        if (this.pendingRequeue.size > 0) {
          const requeuedIds = [...this.pendingRequeue];
          this.pendingRequeue.clear();

          if (gi + 1 < groups.length) {
            // Prepend to the next group
            groups[gi + 1] = {
              ...groups[gi + 1],
              taskIds: [...requeuedIds, ...groups[gi + 1].taskIds],
            };
          } else {
            // No more groups — create a new wave for re-queued tasks
            groups.push({ depth: group.depth + 1, taskIds: requeuedIds });
          }
        }

        await this.persistState(mergedTaskIds, failedTaskIds, gi);

        log.info("parallel:wave-complete", `Wave ${gi + 1} completed`, {
          wave: gi + 1,
        });
        this.emit({ type: "parallel:group-completed", timestamp: this.timestamp() });
      }

      // If interrupted, cleanup was already handled by handleInterrupt
      if (this.interrupted) {
        return { mergedTaskIds, failedTaskIds, serial: false };
      }

      // Merge session branch back to original branch
      let mergeError: string | undefined;
      if (this.originalBranch && this.sessionBranch) {
        await checkoutBranch(this.originalBranch, this.repoRoot);
        try {
          await mergeFF(this.sessionBranch, this.repoRoot);
        } catch {
          // FF merge failed — session branch has diverged from original.
          // Leave the user on the session branch so their work is accessible.
          await checkoutBranch(this.sessionBranch, this.repoRoot);
          mergeError = `Fast-forward merge failed. Your work is on branch '${this.sessionBranch}'. Merge manually with: git merge ${this.sessionBranch}`;
          this.emit({
            type: "parallel:warning",
            timestamp: this.timestamp(),
            message: mergeError,
          });
        }
      }

      await this.cleanup();

      this.deregisterSigintHandler();
      log.info("parallel:complete", "Parallel execution completed", {
        mergedCount: mergedTaskIds.length,
        failedCount: failedTaskIds.length,
      });
      this.emit({ type: "parallel:completed", timestamp: this.timestamp() });

      return { mergedTaskIds, failedTaskIds, serial: false, error: mergeError };
    } catch (error) {
      this.deregisterSigintHandler();
      this.emit({ type: "parallel:failed", timestamp: this.timestamp() });
      await this.handleAbort();
      try { await this.worktreeManager?.cleanupAll(); } catch { /* best effort */ }
      try { if (this.originalBranch) await checkoutBranch(this.originalBranch, this.repoRoot); } catch { /* best effort */ }
      throw error;
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
    getLogger().warn("parallel:abort", "Parallel execution aborted");
    for (const worker of this.activeWorkers) {
      try { worker.stop(); } catch { /* best effort */ }
    }
  }

  private registerSigintHandler(): void {
    this.sigintHandler = () => {
      void this.handleInterrupt();
    };
    process.on("SIGINT", this.sigintHandler);
  }

  private deregisterSigintHandler(): void {
    if (this.sigintHandler) {
      process.removeListener("SIGINT", this.sigintHandler);
      this.sigintHandler = null;
    }
  }

  private async handleInterrupt(): Promise<void> {
    this.aborted = true;
    this.interrupted = true;
    this.deregisterSigintHandler();

    // Stop all active workers
    for (const worker of this.activeWorkers) {
      try {
        worker.stop();
      } catch {
        // Best effort
      }
    }

    // Wait up to 5s for active workers to finish gracefully
    if (this.activeWorkerPromises.length > 0) {
      const timeout = new Promise<void>((resolve) =>
        setTimeout(resolve, ParallelCoordinator.GRACEFUL_SHUTDOWN_TIMEOUT_MS),
      );
      await Promise.race([
        Promise.allSettled(this.activeWorkerPromises),
        timeout,
      ]);
    }

    // Clean up worktrees regardless of worker state
    if (this.worktreeManager) {
      try {
        await this.worktreeManager.cleanupAll();
      } catch {
        // Best effort
      }
    }

    // Checkout original branch
    if (this.originalBranch) {
      try {
        await checkoutBranch(this.originalBranch, this.repoRoot);
      } catch {
        // Best effort
      }
    }

    this.emit({
      type: "parallel:failed",
      timestamp: this.timestamp(),
      reason: "interrupted",
    });

    // Signal run() to unblock and return
    if (this.interruptResolve) {
      this.interruptResolve();
    }
  }

  private handleFailedMerge(
    operation: MergeOperation,
    failedTaskIds: string[],
  ): void {
    const count = this.requeueCounts.get(operation.taskId) ?? 0;
    if (count < this.maxRequeueCount) {
      this.requeueCounts.set(operation.taskId, count + 1);
      this.pendingRequeue.add(operation.taskId);
      void this.queueTaskStatus(operation.taskId, "open");
      this.emit({
        type: "task:requeued",
        timestamp: this.timestamp(),
        taskId: operation.taskId,
        attempt: count + 1,
        maxAttempts: this.maxRequeueCount,
      });
    } else {
      failedTaskIds.push(operation.taskId);
      void this.queueTaskStatus(operation.taskId, "failed");
      this.emit({
        type: "merge:failed",
        timestamp: this.timestamp(),
        operationId: operation.id,
        taskId: operation.taskId,
        reason: operation.error,
      });
    }
  }

  private async branchHasNewCommits(branch: string): Promise<boolean> {
    const handle = spawn({
      cmd: ["git", "log", `${this.sessionBranch}..${branch}`, "--oneline"],
      cwd: this.repoRoot,
    });
    const result = await handle.promise;
    return result.exitCode === 0 && result.stdout.trim() !== "";
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

      const batchWorkers: Worker[] = [];
      const promises: Promise<WorkerResult | null>[] = [];

      // Set activeWorkers/promises before the stagger loop so SIGINT can see
      // workers as they're added during the stagger delay window.
      this.activeWorkers = batchWorkers;
      this.activeWorkerPromises = promises;

      for (let idx = 0; idx < batch.length; idx++) {
        if (this.aborted) break;

        const task = batch[idx];
        const workerId = `w-${task.id}-${idx}`;

        // Stagger: wait for resource capacity and delay between launches (skip for first worker)
        if (idx > 0) {
          await this.waitForResourceCapacity(batchWorkers.length, effectiveWorkers);
          await this.interruptibleDelay(this.staggerDelayMs);
          if (this.aborted || this.interrupted) break;
        }

        getLogger().debug("parallel:worker-spawn", `Spawning worker ${workerId}`, {
          taskId: task.id,
          workerId,
        });

        this.emit({
          type: "worker:created",
          timestamp: this.timestamp(),
          workerId,
        });

        const workerPromise = (async () => {
          const worktree = await this.worktreeManager!.acquire(
            workerId,
            task.id,
            this.sessionBranch!,
          );

          const worker = new Worker(
            {
              id: workerId,
              task,
              worktreePath: worktree.path,
              branchName: worktree.branch,
            },
            this.synthConfig,
            this.agent,
            this.fallbackAgent,
            this.sessionPaths,
          );

          worker.on((event) => {
            if (event.type === "worker:started") {
              void this.queueTaskStatus(task.id, "in_progress");
            }
            if (event.type === "worker:started" || event.type === "worker:progress" || event.type === "worker:output") {
              this.emit(event);
            }
          });

          batchWorkers.push(worker);

          try {
            const result = await worker.start();
            getLogger().debug("parallel:worker-complete", `Worker ${workerId} completed`, {
              taskId: task.id,
              workerId,
            });
            this.emit({
              type: "worker:completed",
              timestamp: this.timestamp(),
              workerId,
            });
            return result;
          } catch {
            getLogger().debug("parallel:worker-complete", `Worker ${workerId} failed`, {
              taskId: task.id,
              workerId,
              success: false,
            });
            await this.queueTaskStatus(task.id, "failed");
            this.emit({
              type: "worker:failed",
              timestamp: this.timestamp(),
              workerId,
            });
            return null;
          }
        })();

        promises.push(workerPromise);
      }

      const batchSettled = Promise.all(promises);

      if (this.interruptPromise) {
        await Promise.race([batchSettled, this.interruptPromise]);
      } else {
        await batchSettled;
      }

      // If interrupted, break out immediately — cleanup handled by handleInterrupt
      if (this.interrupted) {
        this.activeWorkers = [];
        this.activeWorkerPromises = [];
        break;
      }

      const batchResults = await batchSettled;
      this.activeWorkers = [];
      this.activeWorkerPromises = [];
      for (const r of batchResults) {
        if (r) results.push(r);
      }

      // Release worktree directories (but not branches) to free capacity for next batch
      for (const w of batchWorkers) {
        await this.worktreeManager!.releaseDirectory(w.id);
      }
      // Single prune after all releases to sync git's worktree registry
      await spawn({ cmd: ["git", "worktree", "prune"], cwd: this.repoRoot }).promise;
    }

    return results;
  }

  private async waitForResourceCapacity(
    activeCount: number,
    maxConcurrency: number,
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < ParallelCoordinator.RESOURCE_MAX_WAIT_MS) {
      if (this.aborted || this.interrupted) return;

      const { concurrency, reason } = this.resourceMonitor.recommendedConcurrency(maxConcurrency);
      if (activeCount < concurrency) return;

      if (reason) {
        this.emit({
          type: "throttle:active",
          timestamp: this.timestamp(),
          recommendedConcurrency: concurrency,
          maxConcurrency,
          reason,
        });
      }

      await this.interruptibleDelay(ParallelCoordinator.RESOURCE_POLL_INTERVAL_MS);
    }
  }

  private interruptibleDelay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (this.interruptPromise) {
        void this.interruptPromise.then(() => {
          clearTimeout(timer);
          resolve();
        });
      }
    });
  }

  private async buildConflictContext(
    task: Task | undefined,
    mergedTaskIds: string[],
  ): Promise<ConflictResolutionContext> {
    const prd = await this.loadPrdContent();
    const mergedTasks = await this.buildMergedTaskSummaries(mergedTaskIds);
    return {
      prd,
      taskDescription: task?.description ?? "",
      acceptanceCriteria: task?.acceptanceCriteria ?? [],
      mergedTasks,
    };
  }

  private async loadPrdContent(): Promise<string> {
    if (await fileExists(this.sessionPaths.prd)) {
      return await readText(this.sessionPaths.prd);
    }
    return "";
  }

  private async buildMergedTaskSummaries(
    mergedTaskIds: string[],
  ): Promise<{ id: string; title: string; commits: string[] }[]> {
    if (mergedTaskIds.length === 0) return [];

    const taskMap = new Map(this.tasks.map((t) => [t.id, t]));
    const mergedSet = new Set(mergedTaskIds);
    const commitMap = new Map<string, string[]>();

    let logOutput = "";
    try {
      const args = ["--oneline"];
      if (this.sessionStartTag) {
        args.push(`${this.sessionStartTag}..HEAD`);
      }
      logOutput = await gitLog(args, this.repoRoot);
    } catch {
      logOutput = "";
    }

    if (logOutput) {
      for (const line of logOutput.split("\n")) {
        if (!line.trim()) continue;
        const match = line.match(/^[a-f0-9]+\s+(.+)$/);
        if (!match) continue;
        const subject = match[1];
        const taskMatch = subject.match(/feat\(([^)]+)\):/);
        if (!taskMatch) continue;
        const taskId = taskMatch[1];
        if (!mergedSet.has(taskId)) continue;
        const existing = commitMap.get(taskId) ?? [];
        if (!existing.includes(subject)) {
          existing.push(subject);
          commitMap.set(taskId, existing);
        }
      }
    }

    return mergedTaskIds.map((id) => ({
      id,
      title: taskMap.get(id)?.title ?? id,
      commits: commitMap.get(id) ?? [],
    }));
  }

  private async handleAbort(): Promise<void> {
    for (const worker of this.activeWorkers) {
      try {
        worker.stop();
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

  private async tryPersistTaskStatus(
    taskId: string,
    status: Task["status"],
    options?: { durationMs?: number; notes?: string },
  ): Promise<void> {
    try {
      await persistTaskStatus(this.sessionPaths, taskId, status, options);
    } catch {
      // Best effort — don't fail the merge over a status write
    }
  }

  private queueTaskStatus(
    taskId: string,
    status: Task["status"],
    options?: { durationMs?: number; notes?: string },
  ): Promise<void> {
    this.statusWriteChain = this.statusWriteChain
      .then(() => this.tryPersistTaskStatus(taskId, status, options))
      .catch(() => {});
    return this.statusWriteChain;
  }

  private async persistTaskDone(taskId: string, durationMs?: number): Promise<void> {
    await this.queueTaskStatus(taskId, "done", { durationMs });
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
