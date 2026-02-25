import { getPlatform, type SleepInhibitor } from "../platform/index.js";
import {
  getSession,
  getMostRecentSession,
  updateSessionMetadata,
} from "../sessions/registry.js";
import { loadTasks, saveTasks, getProgress, resetOrphanedTasks } from "../tasks/store.js";
import { writeText } from "../utils/fs.js";
import { spawn } from "../utils/process.js";
import { loadTaskOutput, buildIterationMap } from "../engine/output-index.js";
import { ansi, fmt } from "../tui/theme.js";
import { globalTrace } from "../utils/perf.js";
import { stripAnsi } from "../tui/utils.js";
import type { TuiEngineData, TuiContext, CompletionSummary } from "../tui/types.js";
import { TokenAccumulator } from "../engine/tokens.js";
import type { IterationResult } from "../engine/types.js";

import {
  log,
  logError,
  logSuccess,
  applyTheme,
  loadAgentRegistry,
  loadEngine,
  loadRunModule,
  loadParallelCoordinator,
  loadTui,
  loadReviewOrchestrator,
  buildSummaryMarkdown,
  printCompletionSummary,
} from "./helpers.js";

export interface CliContext {
  cwd: string;
  tuiEnabled: boolean;
  parallelMode: boolean;
  parallelWorkers: number | undefined;
  cmdFinalize: (
    sessionId?: string,
    tuiContext?: TuiContext,
    runContext?: { config: import("../config/types.js").SynthConfig; sessionPaths: import("../sessions/types.js").SessionPaths },
  ) => Promise<void>;
}

export async function cmdRun(
  sessionId: string | undefined,
  startIteration: number,
  tuiContext: TuiContext | undefined,
  ctx: CliContext,
): Promise<void> {
  const { cwd, tuiEnabled, parallelWorkers, cmdFinalize } = ctx;
  let { parallelMode } = ctx;

  const config = await applyTheme(cwd);

  // Apply parallel default from config if not explicitly set via CLI flags
  if (!ctx.parallelMode && parallelWorkers === undefined) {
    // Only apply config default when no explicit CLI flag was given.
    // The caller sets parallelMode=true for --parallel or false for --no-parallel.
    // When neither flag is set, the caller passes the config default via ctx.parallelMode.
  }
  // parallelMode is already resolved by the caller; use it directly.

  let plan;
  if (sessionId) {
    plan = await getSession(cwd, sessionId);
  } else {
    plan = await getMostRecentSession(cwd);
  }

  if (!plan) {
    logError("No session found. Run 'synth start' first.");
    process.exit(1);
  }

  if (!(await import("../utils/fs.js").then((m) => m.fileExists(plan!.paths.tasks)))) {
    logError(`Session ${plan.metadata.id} has no tasks. Run 'synth start' to generate them.`);
    process.exit(1);
  }

  const taskFile = await loadTasks(plan.paths.tasks);
  const cleaned = resetOrphanedTasks(taskFile);
  if (cleaned !== taskFile) {
    await saveTasks(plan.paths.tasks, cleaned);
    log(fmt.warn("Reset orphaned in_progress tasks from previous session"));
  }

  const [{ getAgent }, { Engine: EngineClass }, runMod] = await Promise.all([
    loadAgentRegistry(),
    loadEngine(),
    loadRunModule(),
  ]);

  const agent = getAgent(config.agent.name);
  const detection = await agent.detect();
  if (!detection.available) {
    logError(`Agent '${config.agent.name}' not available: ${detection.error}`);
    process.exit(1);
  }

  const run = await runMod.createRun(
    plan.paths,
    plan.metadata.id,
    config.agent.name,
    config.execution.max_iterations,
    cwd,
  );

  const locked = await runMod.acquireLock(plan.paths, run.id);
  if (!locked) {
    logError("Another synth instance is already running for this session.");
    process.exit(1);
  }

  let sleepInhibitor: SleepInhibitor | undefined;
  if (config.execution.prevent_sleep !== false) {
    sleepInhibitor = getPlatform().inhibitSleep("synth session running");
  }

  log(
    `${fmt.bold("synth")} ${ansi.muted}│${ansi.reset} ${fmt.label("session:", plan.metadata.id)} ${ansi.muted}│${ansi.reset} ${fmt.label("agent:", config.agent.name)} ${ansi.muted}│${ansi.reset} ${fmt.label("max:", `${config.execution.max_iterations} iterations`)}`,
  );
  log("");

  await updateSessionMetadata(cwd, plan.metadata.id, { status: "executing" });

  // Parallel execution path
  if (parallelMode) {
    const { ParallelCoordinator, analyzeTaskGraph } = await loadParallelCoordinator();
    const actionableTasks = taskFile.tasks.filter(
      (t) => t.status === "open" || t.status === "in_progress",
    );
    const analysis = analyzeTaskGraph(actionableTasks);

    if (actionableTasks.length < 3 || !analysis.recommendParallel) {
      log(
        fmt.info(
          `${actionableTasks.length} actionable task(s) — using serial execution`,
        ),
      );
    } else {
      const effectiveMaxWorkers = parallelWorkers ?? config.parallel?.max_workers ?? 8;
      log(
        fmt.info(
          `Parallel mode: ${actionableTasks.length} tasks across ${analysis.groups.length} wave(s), max ${effectiveMaxWorkers} workers`,
        ),
      );

      const parallelFallbackAgent = config.agent.fallback
        ? getAgent(config.agent.fallback.name)
        : null;

      const coordinator = new ParallelCoordinator({
        tasks: actionableTasks,
        repoRoot: cwd,
        project: config.project.name,
        sessionPaths: plan.paths,
        config: {
          maxWorkers: parallelWorkers ?? config.parallel?.max_workers,
          aiConflictResolution: config.parallel?.ai_conflict_resolution,
          maxRequeueCount: config.parallel?.max_requeue_count,
          staggerDelayMs: config.parallel?.stagger_delay_ms,
        },
        synthConfig: config,
        agent,
        fallbackAgent: parallelFallbackAgent,
      });

      // Wire parallel execution to the TUI (or fall back to log-based output)
      const { attachParallelLogger } = await import("../finalize/parallel-bridge.js");
      let parallelRenderer: Awaited<ReturnType<typeof import("@opentui/core")["createCliRenderer"]>> | null = null;
      let parallelRoot: ReturnType<typeof import("@opentui/react")["createRoot"]> | null = null;
      let parallelOwnsRenderer = !tuiContext;
      let parallelDestroyed = false;

      if (tuiEnabled) {
        const { createInitialTuiState, applyParallelEvent } = await import("../finalize/parallel-bridge.js");
        const { ParallelBridge } = await import("../tui/ParallelBridge.js");
        const tui = await loadTui();
        if (tuiContext) {
          parallelRenderer = tuiContext.renderer;
          parallelRoot = tuiContext.root;
        } else {
          parallelRenderer = await tui.createCliRenderer({
            useKittyKeyboard: { disambiguate: true, alternateKeys: true },
          });
          parallelRoot = tui.createRoot(parallelRenderer);
        }

        const parallelTaskElapsedMs = Object.fromEntries(
          taskFile.tasks
            .filter((t) => t.durationMs != null)
            .map((t) => [t.id, t.durationMs as number]),
        );

        const parallelTuiData: TuiEngineData = {
          engineState: "executing",
          iteration: 0,
          maxIterations: 1,
          tasks: [...taskFile.tasks],
          currentTaskId: null,
          output: "",
          agentName: config.agent.name,
          projectName: config.project.name,
          sessionId: plan.metadata.id,
          startTime: Date.now(),
          interviewMessages: [],
          isThinking: false,
          currentPhase: "Parallel execution",
          phaseStartTime: Date.now(),
          completionSummary: null,
          taskOutputMap: {},
          taskElapsedMs: parallelTaskElapsedMs,
          taskStartTimes: {},
          iterationEntries: [],
          configDisplay: JSON.stringify(config, null, 2),
          tokenUsage: { sessionTotal: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, taskTotals: {}, hasData: false },
        };

        const totalTasks = taskFile.tasks.length;
        const initialMergedTasks = taskFile.tasks.filter(
          (t) => t.status === "done" || t.status === "skipped",
        ).length;
        const parallelState = createInitialTuiState(totalTasks, initialMergedTasks);

        // Render ONCE — the bridge manages its own re-renders via _notify
        parallelRoot!.render(
          <ParallelBridge
            tuiData={parallelTuiData}
            parallelState={parallelState}
            onQuit={() => coordinator.abort()}
          />,
        );

        let parallelRenderScheduled = false;
        const notifyParallelTuiThrottled = () => {
          if (parallelDestroyed || parallelRenderScheduled) return;
          parallelRenderScheduled = true;
          setTimeout(() => {
            parallelRenderScheduled = false;
            if (!parallelDestroyed) parallelTuiData._notify?.();
          }, 16);
        };

        attachParallelLogger(coordinator.on.bind(coordinator), plan.paths.logs);

        const workerElapsedByTaskId = new Map<string, number>();

        coordinator.on((event) => {
          applyParallelEvent(event, parallelState, () =>
            coordinator.getWorkerDisplayStates(),
          );
          if (event.type === "worker:started" || event.type === "worker:progress" || event.type === "worker:completed" || event.type === "worker:failed") {
            const workers = coordinator.getWorkerDisplayStates();
            const worker = workers.find((w) => w.id === event.workerId);
            if (worker) {
              const taskId = worker.task.id;
              const task = parallelTuiData.tasks.find((t) => t.id === taskId);
              if (task && task.status !== "done" && task.status !== "failed") {
                task.status = "in_progress";
              }
              const startTime = Date.now() - worker.elapsedMs;
              parallelTuiData.taskStartTimes[taskId] = startTime;
              parallelTuiData.taskElapsedMs[taskId] = worker.elapsedMs;
              workerElapsedByTaskId.set(taskId, worker.elapsedMs);
            }
          }
          if (event.type === "worker:output" && "taskId" in event) {
            const taskId = (event as { taskId: string }).taskId;
            parallelTuiData.taskOutputMap[taskId] = (parallelTuiData.taskOutputMap[taskId] ?? "") + (event as { message: string }).message;
          }
          if (event.type === "merge:completed") {
            const task = parallelTuiData.tasks.find((t) => t.id === event.taskId);
            if (task) task.status = "done";
            const elapsed = workerElapsedByTaskId.get(event.taskId);
            if (elapsed != null) {
              parallelTuiData.taskElapsedMs[event.taskId] = elapsed;
            }
          }
          if (event.type === "merge:failed" || event.type === "merge:skipped") {
            const task = parallelTuiData.tasks.find((t) => t.id === event.taskId);
            if (task) task.status = "failed";
          }
          notifyParallelTuiThrottled();
        });
      } else {
        attachParallelLogger(coordinator.on.bind(coordinator), plan.paths.logs);

        coordinator.on((event) => {
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
        });
      }

      try {
        const result = await coordinator.run();
        if (!tuiEnabled) {
          log(
            fmt.info(
              `Parallel result: ${result.mergedTaskIds.length} merged, ${result.failedTaskIds.length} failed`,
            ),
          );
        }
      } finally {
        parallelDestroyed = true;
        await runMod.releaseLock(plan.paths);
        if (parallelOwnsRenderer) {
          try {
            if (parallelRoot) parallelRoot.unmount();
            if (parallelRenderer) parallelRenderer.destroy();
          } catch {
            // Last-resort terminal cleanup
          } finally {
            process.stdout.write("\x1b[?1000l\x1b[?1003l\x1b[?1006l"); // disable mouse tracking modes
            process.stdout.write("\x1b[?25h");  // show cursor
            process.stdout.write("\x1b[?1049l"); // exit alternate screen
          }
        }
      }

      parallelFallbackAgent?.dispose();
      agent.dispose();
      return;
    }
  }

  const fallbackAgent = config.agent.fallback
    ? getAgent(config.agent.fallback.name)
    : null;

  const engine = new EngineClass(config, agent, fallbackAgent, plan.paths, cwd);

  const ownsRenderer = !tuiContext;
  let renderer: Awaited<ReturnType<typeof import("@opentui/core")["createCliRenderer"]>> | null = null;
  let root: ReturnType<typeof import("@opentui/react")["createRoot"]> | null = null;
  let tuiData: TuiEngineData | null = null;
  let App: Awaited<ReturnType<typeof loadTui>>["App"] | null = null;

  if (tuiEnabled) {
    const tui = await loadTui();
    App = tui.App;
    if (tuiContext) {
      renderer = tuiContext.renderer;
      root = tuiContext.root;
    } else {
      renderer = await tui.createCliRenderer({
        useKittyKeyboard: { disambiguate: true, alternateKeys: true },
      });
      root = tui.createRoot(renderer);
    }
    const initialTaskElapsedMs = Object.fromEntries(
      taskFile.tasks
        .filter((t) => t.durationMs != null)
        .map((t) => [t.id, t.durationMs as number]),
    );

    tuiData = {
      engineState: "executing",
      iteration: startIteration,
      maxIterations: config.execution.max_iterations,
      tasks: [...taskFile.tasks],
      currentTaskId: null,
      output: "",
      agentName: config.agent.name,
      projectName: config.project.name,
      sessionId: plan.metadata.id,
      startTime: Date.now(),
      interviewMessages: [],
      isThinking: false,
      currentPhase: null,
      phaseStartTime: null,
      completionSummary: null,
      taskOutputMap: {},
      taskElapsedMs: initialTaskElapsedMs,
      taskStartTimes: {},
      iterationEntries: [],
      configDisplay: JSON.stringify(config, null, 2),
      tokenUsage: { sessionTotal: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, taskTotals: {}, hasData: false },
    };

    // Pre-load historical outputs and iteration entries for tasks completed in previous sessions
    const completedTasks = taskFile.tasks.filter((t) => t.status === "done");
    buildIterationMap(plan.paths.progress).then(async (iterMap) => {
      if (!tuiData || iterMap.length === 0) return;
      // Populate iteration entries from progress.md history
      for (const entry of iterMap) {
        tuiData.iterationEntries.push({
          iteration: entry.iteration,
          taskId: entry.taskId,
          status: "done",
          timestamp: 0, // historical entries don't have precise timestamps
        });
      }
      // Load outputs for completed tasks
      for (const task of completedTasks) {
        if (tuiData.taskOutputMap[task.id]) continue;
        const output = await loadTaskOutput(plan!.paths.logs, task.id, iterMap);
        if (output && !tuiData.taskOutputMap[task.id]) {
          tuiData.taskOutputMap[task.id] = output;
        }
      }
      renderTui();
    });
  }

  let firstTokenRendered = false;
  let completionResolve: ((action: "quit" | "finalize") => void) | null = null;

  const renderTui = () => {
    if (root && tuiData && App) {
      root.render(
        <App
          {...tuiData}
          onQuit={() => {
            if (completionResolve) {
              completionResolve("quit");
            } else {
              cleanup().then(() => process.exit(0));
            }
          }}
          onFinalize={() => {
            if (completionResolve) {
              completionResolve("finalize");
            }
          }}
        />,
      );
    }
  };

  // Throttled variant for high-frequency events (agent:stdout, review chunks).
  // Caps at ~60fps (16ms) to avoid 100+ renders/sec during streaming.
  let renderScheduled = false;
  const renderTuiThrottled = () => {
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      renderTui();
    }, 16);
  };

  const MAX_OUTPUT_LENGTH = 100_000;

  const taskStartTimes = new Map<string, number>();
  const tokenAccumulator = new TokenAccumulator();

  if (tuiEnabled) {
    engine.on((event) => {
      if (!tuiData) return;
      switch (event.type) {
        case "iteration:start":
          tuiData.iteration = event.iteration ?? tuiData.iteration;
          tuiData.currentTaskId = event.taskId ?? null;
          tuiData.output = "";
          firstTokenRendered = false;
          break;
        case "task:start":
          tuiData.isThinking = true;
          tuiData.currentPhase = "Starting task...";
          tuiData.phaseStartTime = event.timestamp ?? Date.now();
          if (event.taskId) {
            tuiData.taskOutputMap[event.taskId] = "";
            const now = Date.now();
            taskStartTimes.set(event.taskId, now);
            tuiData.taskStartTimes[event.taskId] = now;
            const task = tuiData.tasks.find((t) => t.id === event.taskId);
            if (task) task.iterationCount++;
          }
          break;
        case "task:complete":
        case "task:failed": {
          tuiData.isThinking = false;
          tuiData.currentPhase = null;
          tuiData.phaseStartTime = null;
          const task = tuiData.tasks.find((t) => t.id === event.taskId);
          if (task) task.status = event.type === "task:complete" ? "done" : "failed";
          if (event.taskId) {
            const startTime = taskStartTimes.get(event.taskId);
            if (startTime) {
              const taskElapsed = Date.now() - startTime;
              const elapsedSecs = Math.floor(taskElapsed / 1000);
              tuiData.taskElapsedMs[event.taskId] = (tuiData.taskElapsedMs[event.taskId] ?? 0) + taskElapsed;
              const label = event.type === "task:complete" ? "Completed" : "Failed";
              const suffix = `\n${label} in ${elapsedSecs}s`;
              tuiData.taskOutputMap[event.taskId] = (tuiData.taskOutputMap[event.taskId] ?? "") + suffix;
              if (tuiData.currentTaskId === event.taskId) {
                tuiData.output += suffix;
              }
              taskStartTimes.delete(event.taskId);
            }
          }
          break;
        }
        case "phase:scanning":
          tuiData.currentPhase = "Scanning project files...";
          tuiData.phaseStartTime = event.timestamp ?? Date.now();
          break;
        case "phase:building-prompt":
          tuiData.currentPhase = "Building prompt...";
          tuiData.phaseStartTime = event.timestamp ?? Date.now();
          break;
        case "phase:spawning-agent":
          tuiData.currentPhase = "Spawning agent...";
          tuiData.phaseStartTime = event.timestamp ?? Date.now();
          break;
        case "phase:waiting-response":
          tuiData.currentPhase = "Waiting for response...";
          tuiData.phaseStartTime = event.timestamp ?? Date.now();
          break;
        case "phase:streaming":
          tuiData.currentPhase = "Streaming response...";
          tuiData.phaseStartTime = event.timestamp ?? Date.now();
          break;
        case "agent:stdout": {
          // On first chunk, update phase in the same pass to avoid a double render
          const renderStart = event.isFirstChunk ? performance.now() : 0;
          if (event.isFirstChunk) {
            tuiData.currentPhase = "Streaming response...";
            tuiData.phaseStartTime = Date.now();
          }
          const stripped = event.message ? stripAnsi(event.message) : "";
          if (stripped) {
            tuiData.output += stripped;
            if (tuiData.output.length > MAX_OUTPUT_LENGTH) {
              tuiData.output = tuiData.output.slice(-MAX_OUTPUT_LENGTH);
            }
            if (tuiData.currentTaskId && tuiData.currentTaskId in tuiData.taskOutputMap) {
              tuiData.taskOutputMap[tuiData.currentTaskId] += stripped;
              if (tuiData.taskOutputMap[tuiData.currentTaskId].length > MAX_OUTPUT_LENGTH) {
                tuiData.taskOutputMap[tuiData.currentTaskId] = tuiData.taskOutputMap[tuiData.currentTaskId].slice(-MAX_OUTPUT_LENGTH);
              }
            }
          }
          renderTuiThrottled();
          // Record first-token-to-render latency for --profile reporting
          if (event.isFirstChunk && !firstTokenRendered) {
            firstTokenRendered = true;
            const renderMs = performance.now() - renderStart;
            globalTrace().recordPhase("tui:first-token-render", renderMs);
          }
          return; // already rendered above
        }
        case "agent:stderr":
          if (event.message) {
            tuiData.output += stripAnsi(event.message);
            if (tuiData.output.length > MAX_OUTPUT_LENGTH) {
              tuiData.output = tuiData.output.slice(-MAX_OUTPUT_LENGTH);
            }
          }
          break;
        case "iteration:end": {
          const iterData = event.data as IterationResult | undefined;
          if (event.taskId && event.iteration != null) {
            tuiData.iterationEntries.push({
              iteration: event.iteration,
              taskId: event.taskId,
              status: iterData?.success ? "done" : "failed",
              timestamp: Date.now(),
            });
          }
          if (iterData?.tokenUsage && event.taskId) {
            tokenAccumulator.add(event.taskId, {
              inputTokens: iterData.tokenUsage.inputTokens,
              outputTokens: iterData.tokenUsage.outputTokens,
              totalTokens: iterData.tokenUsage.inputTokens + iterData.tokenUsage.outputTokens,
            });
            tuiData.tokenUsage = {
              sessionTotal: tokenAccumulator.getSessionTotal(),
              taskTotals: Object.fromEntries(
                tuiData.tasks.map((t) => [t.id, tokenAccumulator.getTaskTotal(t.id) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }]).filter(([, v]) => (v as { totalTokens: number }).totalTokens > 0),
              ),
              hasData: tokenAccumulator.hasData(),
            };
          }
          break;
        }
        case "complete":
          tuiData.engineState = "completed";
          break;
        case "state:change":
          if (event.message) tuiData.engineState = event.message as TuiEngineData["engineState"];
          break;
      }
      renderTui();
    });
    renderTui();
  } else {
    engine.on((event) => {
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
      }
    });
  }

  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    sleepInhibitor?.release();
    engine.stop();
    if (ownsRenderer) {
      if (root) root.unmount();
      if (renderer) renderer.destroy();
    }
    // Don't overwrite completed status if SIGINT arrives during completion view
    if (engine.getState() === "completed") return;
    await runMod.endRun(plan!.paths, "interrupted");
    await updateSessionMetadata(cwd, plan!.metadata.id, { status: "paused" });
    if (!tuiEnabled) {
      log(`\n${fmt.warn(`Session interrupted. Resume with: synth resume ${plan!.metadata.id}`)}`);
    }
  };

  const onSigInt = () => { cleanup().then(() => process.exit(0)); };
  const onSigTerm = () => { cleanup().then(() => process.exit(0)); };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  // Notifications fire regardless of --no-tui; only suppressed in non-TTY (piped) mode
  const notificationsEnabled = config.notifications?.enabled !== false && process.stdout.isTTY === true;
  const engineStartTime = Date.now();

  try {
    await engine.run(startIteration);
    const finalState = engine.getState();
    await runMod.endRun(plan.paths, finalState === "completed" ? "completed" : "paused");

    // ── Review phase: runs after successful execution, skipped if blocked ──
    if (finalState === "completed") {
      await updateSessionMetadata(cwd, plan.metadata.id, { status: "reviewing" });

      const { ReviewOrchestrator } = await loadReviewOrchestrator();
      const reviewOrchestrator = new ReviewOrchestrator(
        config,
        agent,
        fallbackAgent,
        plan.paths,
        cwd,
      );

      // Swap signal handlers to be review-aware
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);

      let reviewCleaningUp = false;
      const reviewCleanup = async () => {
        if (reviewCleaningUp) return;
        reviewCleaningUp = true;
        reviewOrchestrator.stop();
        await reviewOrchestrator.cleanupPartialFindings();
        if (ownsRenderer) {
          if (root) root.unmount();
          if (renderer) renderer.destroy();
        }
        // Keep status as "reviewing" so resume re-enters review phase
      };

      const onReviewSigInt = () => { reviewCleanup().then(() => process.exit(0)); };
      const onReviewSigTerm = () => { reviewCleanup().then(() => process.exit(0)); };
      process.on("SIGINT", onReviewSigInt);
      process.on("SIGTERM", onReviewSigTerm);

      try {
      if (tuiEnabled && tuiData) {
        // Show review phase in TUI — reuse execution view with "reviewing" state
        tuiData.engineState = "reviewing";
        tuiData.currentTaskId = null;
        tuiData.output = "";
        tuiData.isThinking = true;
        tuiData.currentPhase = "Generating review findings...";
        tuiData.phaseStartTime = Date.now();
        renderTui();

        reviewOrchestrator.on((event) => {
          if (!tuiData) return;
          switch (event.type) {
            case "state:change":
              if (event.message === "reviewing") {
                tuiData.engineState = "reviewing";
              } else if (event.message) {
                tuiData.engineState = event.message as TuiEngineData["engineState"];
              }
              break;
            case "iteration:start":
              tuiData.iteration = event.iteration ?? tuiData.iteration;
              tuiData.currentTaskId = event.taskId ?? null;
              tuiData.output = "";
              break;
            case "task:start":
              tuiData.isThinking = true;
              tuiData.currentPhase = "Executing review task...";
              tuiData.phaseStartTime = event.timestamp ?? Date.now();
              if (event.taskId) {
                tuiData.taskOutputMap[event.taskId] = "";
                tuiData.taskStartTimes[event.taskId] = Date.now();
                const task = tuiData.tasks.find((t) => t.id === event.taskId);
                if (task) task.iterationCount++;
              }
              break;
            case "task:complete":
            case "task:failed": {
              tuiData.isThinking = false;
              tuiData.currentPhase = null;
              const task = tuiData.tasks.find((t) => t.id === event.taskId);
              if (task) task.status = event.type === "task:complete" ? "done" : "failed";
              break;
            }
            case "agent:stdout": {
              const stripped = event.message ? stripAnsi(event.message) : "";
              if (stripped) {
                tuiData.output += stripped;
                if (tuiData.currentTaskId && tuiData.currentTaskId in tuiData.taskOutputMap) {
                  tuiData.taskOutputMap[tuiData.currentTaskId] += stripped;
                }
              }
              renderTui();
              return; // already rendered
            }
            case "agent:stderr":
              if (event.message) tuiData.output += stripAnsi(event.message);
              break;
            case "phase:scanning":
              tuiData.currentPhase = "Scanning project files...";
              tuiData.phaseStartTime = event.timestamp ?? Date.now();
              break;
            case "phase:building-prompt":
              tuiData.currentPhase = "Building prompt...";
              tuiData.phaseStartTime = event.timestamp ?? Date.now();
              break;
            case "phase:spawning-agent":
              tuiData.currentPhase = "Spawning agent...";
              tuiData.phaseStartTime = event.timestamp ?? Date.now();
              break;
            case "phase:streaming":
              tuiData.currentPhase = "Streaming response...";
              tuiData.phaseStartTime = event.timestamp ?? Date.now();
              break;
            case "complete":
              tuiData.isThinking = false;
              tuiData.currentPhase = null;
              break;
          }
          renderTui();
        });

        // Load and display review tasks in TUI as they're generated
        const reviewResult = await reviewOrchestrator.run((chunk) => {
          if (tuiData) {
            tuiData.output += chunk;
            if (tuiData.output.length > MAX_OUTPUT_LENGTH) {
              tuiData.output = tuiData.output.slice(-MAX_OUTPUT_LENGTH);
            }
            renderTuiThrottled();
          }
        });

        // Merge review tasks into TUI task list if any were created
        if (reviewResult.taskFile) {
          tuiData.tasks = [...tuiData.tasks, ...reviewResult.taskFile.tasks];
        }
        tuiData.engineState = "completed";
        renderTui();
      } else {
        // Non-TUI: log review progress to console
        log(`\n${fmt.bold("━━━ Review Phase ━━━")}`);
        log(fmt.info("Analyzing execution output for issues..."));

        reviewOrchestrator.on((event) => {
          switch (event.type) {
            case "iteration:start":
              log(`\n${fmt.bold(`━━━ Review Iteration ${event.iteration} ━━━`)} ${fmt.label("task:", event.taskId ?? "")}`);
              break;
            case "task:complete":
              logSuccess(`  ${event.taskId}: ${event.message}`);
              break;
            case "task:failed":
              logError(`  ${event.taskId}: ${event.message}`);
              break;
            case "agent:stdout":
              if (event.message) process.stdout.write(event.message);
              break;
          }
        });

        const reviewResult = await reviewOrchestrator.run();
        if (reviewResult.findings.length > 0) {
          log(fmt.info(`Review found ${reviewResult.findings.length} finding(s)${reviewResult.executed ? " — fix tasks executed" : ""}`));
        } else {
          log(fmt.info("Review completed — no issues found"));
        }
      }

      // Review done — transition back to completed
      await updateSessionMetadata(cwd, plan.metadata.id, { status: "completed" });
      } finally {
        process.off("SIGINT", onReviewSigInt);
        process.off("SIGTERM", onReviewSigTerm);
        // Restore original signal handlers for the remaining finally block
        process.on("SIGINT", onSigInt);
        process.on("SIGTERM", onSigTerm);
      }
    } else {
      // Non-completed states (blocked, paused) — skip review
      await updateSessionMetadata(cwd, plan.metadata.id, {
        status: finalState === "blocked" ? "blocked" : "paused",
      });
    }

    const durationMs = Date.now() - engineStartTime;
    const currentTasks = await loadTasks(plan.paths.tasks);
    const progress = getProgress(currentTasks);

    // Show completion summary when engine finishes successfully
    if (finalState === "completed") {
      // Gather git commits made during this run
      const sinceDate = new Date(engineStartTime).toISOString();
      const gitResult = spawn({ cmd: ["git", "log", "--oneline", `--since=${sinceDate}`], cwd });
      const { stdout: commitLog } = await gitResult.promise;
      const commits = commitLog.trim() ? commitLog.trim().split("\n") : [];

      const summaryData: CompletionSummary = {
        projectName: config.project.name,
        sessionId: plan.metadata.id,
        agentName: config.agent.name,
        totalDurationMs: durationMs,
        totalIterations: engine.getIteration(),
        tasks: currentTasks.tasks,
        progress,
        commits,
        summaryFilePath: plan.paths.summary,
      };

      // Write summary.md
      const markdown = buildSummaryMarkdown(summaryData);
      await writeText(plan.paths.summary, markdown);

      if (tuiEnabled && tuiData) {
        // Set completion summary and re-render — App auto-switches to CompletionView
        tuiData.completionSummary = summaryData;
        renderTui();
        // Wait for user to press q/Esc or f (finalize)
        const completionAction = await new Promise<"quit" | "finalize">((resolve) => {
          completionResolve = resolve;
        });
        completionResolve = null;

        if (completionAction === "finalize") {
          // Transition to finalize phase, reusing renderer/root.
          // Capture references before nulling, so we can clean up after finalize.
          const finalizeRenderer = renderer;
          const finalizeRoot = root;
          // Null out so the finally block won't double-unmount/destroy
          renderer = null;
          root = null;
          cleaningUp = true; // prevent SIGINT cleanup from interfering

          await cmdFinalize(plan.metadata.id, { renderer: finalizeRenderer!, root: finalizeRoot! }, {
            config,
            sessionPaths: plan.paths,
          });
          if (ownsRenderer) {
            finalizeRoot?.unmount();
            finalizeRenderer?.destroy();
          }
          return;
        }
      } else {
        printCompletionSummary(summaryData);
        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`\nCreate PR? (Y/n) `, resolve);
        });
        rl.close();
        if (!answer || answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
          await cmdFinalize(plan.metadata.id);
        }
      }
    }

    if (notificationsEnabled) {
      const notif = await import("../notifications.js");

      if (finalState === "completed") {
        notif.sendCompletionNotification({ durationMs, taskCount: progress.done });
      } else if (finalState === "paused" && engine.getIteration() >= config.execution.max_iterations) {
        notif.sendMaxIterationsNotification({
          iterationsRun: engine.getIteration(),
          tasksCompleted: progress.done,
          tasksRemaining: progress.open,
          durationMs,
        });
      }
    }
  } catch (err) {
    await runMod.endRun(plan.paths, "failed");
    await updateSessionMetadata(cwd, plan.metadata.id, { status: "failed" });
    if (!tuiEnabled) logError(`Engine error: ${err}`);

    if (notificationsEnabled) {
      const durationMs = Date.now() - engineStartTime;
      const currentTasks = await loadTasks(plan.paths.tasks).catch(() => null);
      const tasksCompleted = currentTasks ? getProgress(currentTasks).done : 0;
      const notif = await import("../notifications.js");
      notif.sendErrorNotification({
        errorSummary: String(err),
        tasksCompleted,
        durationMs,
      });
    }
  } finally {
    sleepInhibitor?.release();
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    if (ownsRenderer) {
      if (root) root.unmount();
      if (renderer) renderer.destroy();
    }
    await runMod.releaseLock(plan.paths);
    agent.dispose();
    fallbackAgent?.dispose();
  }
}
