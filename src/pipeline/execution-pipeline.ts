import type {
  PipelineOptions,
  PipelineState,
  PipelinePhase,
  PipelineEvent,
  PipelineEventListener,
  PipelineEmitter,
  UserAction,
} from "./types.js";
import type { Task } from "../tasks/types.js";
import type { AgentAdapter } from "../agents/types.js";
import type { EngineEvent } from "../engine/types.js";
import type { ParallelEvent } from "../parallel/events.js";
import type { CompletionSummary } from "./types.js";

// ---------------------------------------------------------------------------
// Lazy-loaded modules (same pattern as src/commands/helpers.ts)
// ---------------------------------------------------------------------------

let _agentRegistry: Awaited<ReturnType<typeof lazyAgentRegistry>> | null = null;
async function lazyAgentRegistry() {
  if (_agentRegistry) return _agentRegistry;
  const { getAgent } = await import("../agents/registry.js");
  _agentRegistry = { getAgent };
  return _agentRegistry;
}

let _engine: Awaited<ReturnType<typeof lazyEngine>> | null = null;
async function lazyEngine() {
  if (_engine) return _engine;
  const { Engine } = await import("../engine/engine.js");
  _engine = { Engine };
  return _engine;
}

let _runModule: Awaited<ReturnType<typeof lazyRunModule>> | null = null;
async function lazyRunModule() {
  if (_runModule) return _runModule;
  const mod = await import("../run/run.js");
  _runModule = {
    createRun: mod.createRun,
    acquireLock: mod.acquireLock,
    releaseLock: mod.releaseLock,
    endRun: mod.endRun,
  };
  return _runModule;
}

let _reviewOrchestrator: Awaited<ReturnType<typeof lazyReviewOrchestrator>> | null = null;
async function lazyReviewOrchestrator() {
  if (_reviewOrchestrator) return _reviewOrchestrator;
  const { ReviewOrchestrator } = await import("../review/orchestrator.js");
  _reviewOrchestrator = { ReviewOrchestrator };
  return _reviewOrchestrator;
}

let _parallelCoordinator: Awaited<ReturnType<typeof lazyParallelCoordinator>> | null = null;
async function lazyParallelCoordinator() {
  if (_parallelCoordinator) return _parallelCoordinator;
  const [{ ParallelCoordinator }, { analyzeTaskGraph }] = await Promise.all([
    import("../parallel/coordinator.js"),
    import("../parallel/task-graph.js"),
  ]);
  _parallelCoordinator = { ParallelCoordinator, analyzeTaskGraph };
  return _parallelCoordinator;
}

async function lazyTaskStore() {
  const mod = await import("../tasks/store.js");
  return {
    loadTasks: mod.loadTasks,
    saveTasks: mod.saveTasks,
    getProgress: mod.getProgress,
    resetOrphanedTasks: mod.resetOrphanedTasks,
  };
}

async function lazySessionRegistry() {
  const { updateSessionMetadata } = await import("../sessions/registry.js");
  return { updateSessionMetadata };
}

async function lazyFs() {
  const { writeText } = await import("../utils/fs.js");
  return { writeText };
}

async function lazyGit() {
  const { getCurrentBranch, checkoutBranch } = await import("../utils/git.js");
  return { getCurrentBranch, checkoutBranch };
}

async function lazyProcess() {
  const { spawn } = await import("../utils/process.js");
  return { spawn };
}

async function lazyFormat() {
  const { formatDuration } = await import("../utils/format.js");
  return { formatDuration };
}

async function lazyLogBridge() {
  const { createEngineLogBridge } = await import("../logging/engine-bridge.js");
  return { createEngineLogBridge };
}

async function lazyLogger() {
  const { getLogger } = await import("../logging/logger.js");
  return { getLogger };
}

async function lazyPlatform() {
  const { getPlatform } = await import("../platform/index.js");
  return { getPlatform };
}

// ---------------------------------------------------------------------------
// createBackgroundAudit — pipeline-internal helper
// ---------------------------------------------------------------------------

interface BackgroundAuditState {
  status: "running" | "done" | "error";
  buffer: string;
  error?: string;
}

function createBackgroundAudit() {
  let state: BackgroundAuditState = { status: "running", buffer: "" };

  const appendChunk = (chunk: string) => {
    if (!chunk) return;
    state = { ...state, buffer: state.buffer + chunk };
  };

  const setStatus = (status: BackgroundAuditState["status"], error?: string) => {
    state = { ...state, status, error };
  };

  const getState = () => state;

  return { getState, appendChunk, setStatus };
}

// ---------------------------------------------------------------------------
// buildSummaryMarkdown — local version without TUI imports
// ---------------------------------------------------------------------------

function buildSummaryMarkdown(
  data: Omit<CompletionSummary, "summaryFilePath">,
  formatDuration: (ms: number) => string,
): string {
  const dur = formatDuration(data.totalDurationMs);
  const lines: string[] = [
    `# Completion Summary`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Project | ${data.projectName} |`,
    `| Session | ${data.sessionId} |`,
    `| Agent | ${data.agentName} |`,
    `| Duration | ${dur} |`,
    `| Iterations | ${data.totalIterations} |`,
    `| Tasks | ${data.progress.done}/${data.progress.total} done, ${data.progress.failed} failed, ${data.progress.open} open |`,
    ``,
    `## Tasks`,
    ``,
  ];

  for (const task of data.tasks) {
    const icon = task.status === "done" ? "[x]" : task.status === "failed" ? "[-]" : "[ ]";
    lines.push(`- ${icon} **${task.id}** ${task.title} — \`${task.status}\``);
  }

  if (data.commits.length > 0) {
    lines.push(``, `## Commits`, ``);
    for (const c of data.commits) {
      lines.push(`- ${c}`);
    }
  }

  lines.push(``);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ExecutionPipeline
// ---------------------------------------------------------------------------

export class ExecutionPipeline implements PipelineEmitter {
  private phase: PipelinePhase = "initializing";
  private listeners: PipelineEventListener[] = [];
  private tasks: Task[] = [];
  private currentTaskId: string | null = null;
  private iteration = 0;
  private summary: CompletionSummary | null = null;
  private error: Error | null = null;

  private readonly options: PipelineOptions;
  private agent: AgentAdapter | null = null;
  private fallbackAgent: AgentAdapter | null = null;
  private engine: InstanceType<typeof import("../engine/engine.js").Engine> | null = null;
  private coordinator: InstanceType<typeof import("../parallel/coordinator.js").ParallelCoordinator> | null = null;
  private stopped = false;
  private actionResolve: ((action: UserAction) => void) | null = null;
  private runModule: Awaited<ReturnType<typeof lazyRunModule>> | null = null;
  private sleepInhibitor: { release(): void } | null = null;
  private originalBranch: string | null = null;
  private sigintHandler: (() => void) | null = null;
  private sigtermHandler: (() => void) | null = null;

  constructor(options: PipelineOptions) {
    this.options = options;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  on(listener: PipelineEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async run(): Promise<void> {
    try {
      await this.runLifecycle();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.error = error;
      this.emitEvent({ type: "error", error, phase: this.phase });
      await this.handleFatalError(error);
      this.setPhase("failed");
    } finally {
      await this.cleanup();
    }
  }

  stop(): void {
    this.stopped = true;
    this.engine?.stop();
    if (this.coordinator) {
      void this.coordinator.abort();
    }
    if (this.actionResolve) {
      this.actionResolve({ requestId: "stop", key: "quit" });
    }
  }

  getState(): PipelineState {
    return {
      phase: this.phase,
      tasks: [...this.tasks],
      currentTaskId: this.currentTaskId,
      iteration: this.iteration,
      summary: this.summary,
      error: this.error,
    };
  }

  submitAction(action: UserAction): void {
    if (this.actionResolve) {
      this.actionResolve(action);
      this.actionResolve = null;
    }
  }

  getWorkerDisplayStates(): import("../parallel/worker.js").WorkerDisplayState[] {
    return this.coordinator?.getWorkerDisplayStates() ?? [];
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private async runLifecycle(): Promise<void> {
    // Phase: initializing
    this.setPhase("initializing");

    const { config, sessionPaths, sessionId, cwd } = this.options;
    const { getLogger } = await lazyLogger();
    const logger = getLogger();

    // Save original branch for restoration on cleanup
    const { getCurrentBranch } = await lazyGit();
    this.originalBranch = await getCurrentBranch(cwd).catch(() => null);

    // Load tasks
    const store = await lazyTaskStore();
    let taskFile = await store.loadTasks(sessionPaths.tasks);
    const cleaned = store.resetOrphanedTasks(taskFile);
    if (cleaned !== taskFile) {
      await store.saveTasks(sessionPaths.tasks, cleaned);
      this.emitLog("info", "Reset orphaned in_progress tasks from previous session");
      taskFile = cleaned;
    }
    this.tasks = [...taskFile.tasks];

    const actionableTasks = taskFile.tasks.filter(
      (t) => t.status === "open" || t.status === "in_progress",
    );
    const hasActionableTasks = actionableTasks.length > 0;

    // Detect agent
    const { getAgent } = await lazyAgentRegistry();
    this.agent = getAgent(config.agent.name);
    const detection = await this.agent.detect();
    if (!detection.available) {
      throw new Error(`Agent '${config.agent.name}' not available: ${detection.error}`);
    }
    this.fallbackAgent = config.agent.fallback
      ? getAgent(config.agent.fallback.name)
      : null;

    // Create run and acquire lock
    this.runModule = await lazyRunModule();
    const run = await this.runModule.createRun(
      sessionPaths,
      sessionId,
      config.agent.name,
      config.execution.max_iterations,
      cwd,
    );

    const locked = await this.runModule.acquireLock(sessionPaths, run.id);
    if (!locked) {
      throw new Error("Another synth instance is already running for this session.");
    }

    // Inhibit sleep
    if (config.execution.prevent_sleep !== false) {
      const { getPlatform } = await lazyPlatform();
      this.sleepInhibitor = getPlatform().inhibitSleep("synth session running");
    }

    // Register signal handlers
    this.registerSignalHandlers();

    // Update session status
    const { updateSessionMetadata } = await lazySessionRegistry();
    await updateSessionMetadata(cwd, sessionId, { status: "executing" });

    logger.info("pipeline:start", "Pipeline started", {
      sessionId,
      parallelMode: this.options.parallelMode,
      hasActionableTasks,
    });

    const engineStartTime = Date.now();

    // Phase: executing
    if (!hasActionableTasks) {
      this.emitLog("info", "No actionable tasks — skipping execution phase");
      this.emitEvent({ type: "execution:completed", success: true });
    } else {
      this.setPhase("executing");

      let usedParallel = false;
      let executionSuccess = true;

      if (this.options.parallelMode) {
        const parallelResult = await this.executeParallel(
          actionableTasks,
        );
        usedParallel = parallelResult.usedParallel;
        executionSuccess = parallelResult.success;
      }

      if (!usedParallel) {
        executionSuccess = await this.executeSerial();
      }

      this.emitEvent({ type: "execution:completed", success: executionSuccess });

      if (this.stopped) {
        await this.runModule.endRun(sessionPaths, "interrupted");
        await updateSessionMetadata(cwd, sessionId, { status: "paused" });
        this.setPhase("done");
        return;
      }

      if (!executionSuccess) {
        await this.runModule.endRun(sessionPaths, "paused");
        await updateSessionMetadata(cwd, sessionId, { status: "paused" });
        this.setPhase("done");
        return;
      }
    }

    await this.runModule.endRun(sessionPaths, "completed");

    // Phase: reviewing
    this.setPhase("reviewing");
    await updateSessionMetadata(cwd, sessionId, { status: "reviewing" });

    this.emitEvent({ type: "review:status-changed", status: "running" });

    const audit = createBackgroundAudit();
    try {
      const { ReviewOrchestrator } = await lazyReviewOrchestrator();
      const reviewOrchestrator = new ReviewOrchestrator(
        config,
        this.agent!,
        this.fallbackAgent,
        sessionPaths,
        cwd,
      );

      const { createEngineLogBridge } = await lazyLogBridge();
      reviewOrchestrator.on(createEngineLogBridge(logger));

      reviewOrchestrator.on((event: EngineEvent) => {
        this.emitEvent({ type: "engine:event", event });
      });

      const reviewResult = await reviewOrchestrator.run((chunk) => {
        audit.appendChunk(chunk);
      });

      audit.setStatus("done");
      this.emitEvent({ type: "review:status-changed", status: "ready" });

      if (reviewResult.findings.length > 0) {
        this.emitLog(
          "info",
          `Review found ${reviewResult.findings.length} finding(s)${reviewResult.executed ? " — fix tasks executed" : ""}`,
        );
      } else {
        this.emitLog("info", "Review completed — no issues found");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit.setStatus("error", message);
      this.emitEvent({ type: "review:status-changed", status: "error", error: message });
      this.emitLog("warn", `Review failed: ${message}`);
    }

    // Phase: summarizing
    this.setPhase("summarizing");

    const durationMs = Date.now() - engineStartTime;
    const currentTasks = await store.loadTasks(sessionPaths.tasks);
    this.tasks = [...currentTasks.tasks];
    const progress = store.getProgress(currentTasks);

    const { spawn } = await lazyProcess();
    const sinceDate = new Date(engineStartTime).toISOString();
    const gitResult = spawn({
      cmd: ["git", "log", "--oneline", `--since=${sinceDate}`],
      cwd,
    });
    const { stdout: commitLog } = await gitResult.promise;
    const commits = commitLog.trim() ? commitLog.trim().split("\n") : [];

    const summaryData: CompletionSummary = {
      projectName: config.project.name,
      sessionId,
      agentName: config.agent.name,
      totalDurationMs: durationMs,
      totalIterations: this.iteration,
      tasks: currentTasks.tasks,
      progress,
      commits,
      summaryFilePath: sessionPaths.summary,
    };

    const { formatDuration } = await lazyFormat();
    const markdown = buildSummaryMarkdown(summaryData, formatDuration);
    const { writeText } = await lazyFs();
    await writeText(sessionPaths.summary, markdown);

    this.summary = summaryData;
    this.emitEvent({ type: "summary:ready", summary: summaryData });

    await updateSessionMetadata(cwd, sessionId, { status: "completed" });

    // Phase: awaiting-action
    this.setPhase("awaiting-action");

    const action = await this.awaitAction();

    if (action.key === "quit") {
      this.setPhase("done");
      return;
    }

    if (action.key === "finalize") {
      this.setPhase("finalizing");
      this.emitLog("info", "Finalize requested — pipeline handing off to finalize");
      this.setPhase("done");
      return;
    }

    if (action.key === "review") {
      this.emitLog("info", "Review requested — pipeline handing off to review");
      this.setPhase("done");
      return;
    }

    this.setPhase("done");
  }

  // -------------------------------------------------------------------------
  // Execution: Serial
  // -------------------------------------------------------------------------

  private async executeSerial(): Promise<boolean> {
    const { config, sessionPaths, cwd, startIteration } = this.options;
    const { Engine } = await lazyEngine();
    const { getLogger } = await lazyLogger();
    const logger = getLogger();
    const { createEngineLogBridge } = await lazyLogBridge();

    this.engine = new Engine(
      config,
      this.agent!,
      this.fallbackAgent,
      sessionPaths,
      cwd,
    );

    this.engine.on(createEngineLogBridge(logger));

    this.engine.on((event: EngineEvent) => {
      this.forwardEngineEvent(event);
    });

    await this.engine.run(startIteration);
    const finalState = this.engine.getState();
    this.iteration = this.engine.getIteration();

    return finalState === "completed";
  }

  // -------------------------------------------------------------------------
  // Execution: Parallel
  // -------------------------------------------------------------------------

  private async executeParallel(
    actionableTasks: Task[],
  ): Promise<{ usedParallel: boolean; success: boolean }> {
    const { config, sessionPaths, cwd, parallelWorkers } = this.options;

    const { ParallelCoordinator, analyzeTaskGraph } = await lazyParallelCoordinator();
    const analysis = analyzeTaskGraph(actionableTasks);

    if (actionableTasks.length < 3 || !analysis.recommendParallel) {
      this.emitLog(
        "info",
        `${actionableTasks.length} actionable task(s) — using serial execution`,
      );
      return { usedParallel: false, success: true };
    }

    const effectiveMaxWorkers = parallelWorkers ?? config.parallel?.max_workers ?? 8;
    this.emitLog(
      "info",
      `Parallel mode: ${actionableTasks.length} tasks across ${analysis.groups.length} wave(s), max ${effectiveMaxWorkers} workers`,
    );

    this.coordinator = new ParallelCoordinator({
      tasks: actionableTasks,
      repoRoot: cwd,
      project: config.project.name,
      sessionPaths,
      config: {
        maxWorkers: parallelWorkers ?? config.parallel?.max_workers,
        aiConflictResolution: config.parallel?.ai_conflict_resolution,
        maxRequeueCount: config.parallel?.max_requeue_count,
        staggerDelayMs: config.parallel?.stagger_delay_ms,
      },
      synthConfig: config,
      agent: this.agent!,
      fallbackAgent: this.fallbackAgent,
    });

    this.coordinator.on((event: ParallelEvent) => {
      this.emitEvent({ type: "parallel:event", event });

      // Track task status changes from parallel events
      if (event.type === "merge:completed") {
        const task = this.tasks.find((t) => t.id === event.taskId);
        if (task) {
          task.status = "done";
          this.emitEvent({
            type: "task:status-changed",
            taskId: event.taskId,
            status: "done",
            task: { ...task },
          });
        }
      }
      if (event.type === "merge:failed" || event.type === "merge:skipped") {
        const task = this.tasks.find((t) => t.id === event.taskId);
        if (task) {
          task.status = "failed";
          this.emitEvent({
            type: "task:status-changed",
            taskId: event.taskId,
            status: "failed",
            task: { ...task },
          });
        }
      }
    });

    const { getLogger } = await lazyLogger();
    const logger = getLogger();
    logger.info("parallel:run-start", "Parallel execution started", {
      sessionId: this.options.sessionId,
    });

    const result = await this.coordinator.run();

    logger.info("parallel:run-complete", "Parallel execution completed", {
      merged: result.mergedTaskIds.length,
      failed: result.failedTaskIds.length,
    });

    const success = result.failedTaskIds.length === 0 && !result.error;
    return { usedParallel: true, success };
  }

  // -------------------------------------------------------------------------
  // Action handling
  // -------------------------------------------------------------------------

  private awaitAction(): Promise<UserAction> {
    return new Promise<UserAction>((resolve) => {
      this.actionResolve = resolve;
    });
  }

  // -------------------------------------------------------------------------
  // Event helpers
  // -------------------------------------------------------------------------

  private emitEvent(event: PipelineEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private emitLog(level: "info" | "warn" | "error" | "debug", message: string): void {
    this.emitEvent({ type: "log", level, message });
  }

  private setPhase(phase: PipelinePhase): void {
    const previous = this.phase;
    this.phase = phase;
    this.emitEvent({ type: "phase:changed", phase, previousPhase: previous });
  }

  private forwardEngineEvent(event: EngineEvent): void {
    this.emitEvent({ type: "engine:event", event });

    // Track task/iteration state from engine events
    if (event.type === "iteration:start") {
      this.iteration = event.iteration ?? this.iteration;
      this.currentTaskId = event.taskId ?? null;
    }
    if (event.type === "task:start" && event.taskId) {
      this.currentTaskId = event.taskId;
      const task = this.tasks.find((t) => t.id === event.taskId);
      if (task) {
        task.status = "in_progress";
        this.emitEvent({
          type: "task:status-changed",
          taskId: event.taskId,
          status: "in_progress",
          task: { ...task },
        });
      }
    }
    if (event.type === "task:complete" && event.taskId) {
      const task = this.tasks.find((t) => t.id === event.taskId);
      if (task) {
        task.status = "done";
        this.emitEvent({
          type: "task:status-changed",
          taskId: event.taskId,
          status: "done",
          task: { ...task },
        });
      }
    }
    if (event.type === "task:failed" && event.taskId) {
      const task = this.tasks.find((t) => t.id === event.taskId);
      if (task) {
        task.status = "failed";
        this.emitEvent({
          type: "task:status-changed",
          taskId: event.taskId,
          status: "failed",
          task: { ...task },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Signal handling
  // -------------------------------------------------------------------------

  private registerSignalHandlers(): void {
    this.sigintHandler = () => {
      this.stop();
      void this.cleanup().then(() => process.exit(0));
    };
    this.sigtermHandler = () => {
      this.stop();
      void this.cleanup().then(() => process.exit(0));
    };
    process.on("SIGINT", this.sigintHandler);
    process.on("SIGTERM", this.sigtermHandler);
  }

  private deregisterSignalHandlers(): void {
    if (this.sigintHandler) {
      process.removeListener("SIGINT", this.sigintHandler);
      this.sigintHandler = null;
    }
    if (this.sigtermHandler) {
      process.removeListener("SIGTERM", this.sigtermHandler);
      this.sigtermHandler = null;
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  private async cleanup(): Promise<void> {
    this.deregisterSignalHandlers();

    this.sleepInhibitor?.release();
    this.sleepInhibitor = null;

    if (this.runModule) {
      await this.runModule.releaseLock(this.options.sessionPaths);
    }

    this.agent?.dispose();
    this.fallbackAgent?.dispose();

    // Restore original branch
    if (this.originalBranch) {
      try {
        const { checkoutBranch } = await lazyGit();
        await checkoutBranch(this.originalBranch, this.options.cwd);
      } catch {
        // Best effort
      }
    }
  }

  private async handleFatalError(_error: Error): Promise<void> {
    const { sessionPaths, cwd, sessionId } = this.options;
    try {
      if (this.runModule) {
        await this.runModule.endRun(sessionPaths, "failed");
      }
      const { updateSessionMetadata } = await lazySessionRegistry();
      await updateSessionMetadata(cwd, sessionId, { status: "failed" });
    } catch {
      // Best effort during error handling
    }
  }
}
