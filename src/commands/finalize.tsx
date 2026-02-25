import type { SynthConfig } from "../config/types.js";
import type { SessionPaths } from "../sessions/types.js";
import type { TuiContext } from "../tui/types.js";
import type { FinalizeMessage, OrchestratorState } from "../finalize/chat-types.js";
import { loadConfig } from "../config/loader.js";
import { resolveTheme } from "../tui/themes/resolve.js";
import {
  getSession,
  getMostRecentSession,
  updateSessionMetadata,
} from "../sessions/registry.js";
import { ansi, fmt, initTheme } from "../tui/theme.js";

export interface FinalizeRunContext {
  config: SynthConfig;
  sessionPaths: SessionPaths;
}

export interface CliContext {
  tuiEnabled: boolean;
  cwd: string;
}

// ── Lazy loaders (same pattern as cli.tsx) ──

async function loadAgentRegistry() {
  const { getAgent } = await import("../agents/registry.js");
  return { getAgent };
}

async function loadTui() {
  const [
    { createCliRenderer },
    { createRoot },
    { FinalizeApp },
  ] = await Promise.all([
    import("@opentui/core"),
    import("@opentui/react"),
    import("../tui/FinalizeApp.js"),
  ]);
  return { createCliRenderer, createRoot, FinalizeApp };
}

async function loadFinalize() {
  const { finalize } = await import("../finalize/finalize.js");
  return { finalize };
}

async function loadParallelCoordinator() {
  const { ParallelCoordinator } = await import("../parallel/coordinator.js");
  const { analyzeTaskGraph } = await import("../parallel/task-graph.js");
  return { ParallelCoordinator, analyzeTaskGraph };
}

// ── Logging helpers ──

function log(msg: string): void {
  console.log(msg);
}

function logError(msg: string): void {
  console.error(fmt.error(msg));
}

function logSuccess(msg: string): void {
  console.log(fmt.success(msg));
}

async function applyTheme(cwd: string): Promise<SynthConfig> {
  const config = await loadConfig(cwd);
  const { theme, spinnerFrames } = await resolveTheme(config);
  initTheme(theme, spinnerFrames);
  return config;
}

// ── Main exported function ──

export async function cmdFinalize(
  sessionId?: string,
  tuiContext?: TuiContext,
  runContext?: FinalizeRunContext,
  savedConversation?: FinalizeMessage[],
  savedState?: OrchestratorState,
  ctx?: CliContext,
): Promise<void> {
  const cwd = ctx?.cwd ?? process.cwd();
  const tuiEnabled = ctx?.tuiEnabled ?? (process.stdout.isTTY === true);

  const config = runContext?.config ?? await applyTheme(cwd);

  let plan;
  if (sessionId) {
    plan = await getSession(cwd, sessionId);
  } else {
    plan = await getMostRecentSession(cwd);
  }

  if (!plan) {
    logError("No session found to finalize.");
    process.exit(1);
  }

  // Re-entry guard: already finalized plans cannot be re-finalized
  if (plan.metadata.status === "finalized") {
    logError(`Session '${plan.metadata.id}' is already finalized.`);
    process.exit(1);
  }

  // Mark session as finalizing so resume can detect interrupted finalize
  if (plan.metadata.status !== "finalizing") {
    await updateSessionMetadata(cwd, plan.metadata.id, { status: "finalizing" });
  }

  if (tuiEnabled) {
    // ── Interactive TUI mode ──
    const [{ getAgent }, { FinalizeOrchestrator }] = await Promise.all([
      loadAgentRegistry(),
      import("../finalize/orchestrator.js"),
    ]);
    const tui = await loadTui();

    const agent = getAgent(config.agent.name);
    const orchestrator = new FinalizeOrchestrator();

    // Restore from saved conversation if resuming an interrupted finalize
    if (savedConversation?.length) {
      orchestrator.restore(agent, config, plan.paths, cwd, savedConversation, savedState);
    }

    const ownsRenderer = !tuiContext;
    let renderer = tuiContext?.renderer ?? null;
    let root = tuiContext?.root ?? null;

    if (!renderer || !root) {
      renderer = await tui.createCliRenderer({
        exitOnCtrlC: false,
        useKittyKeyboard: { disambiguate: true, alternateKeys: true },
      });
      root = tui.createRoot(renderer);
    }

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (ownsRenderer) {
        root?.unmount();
        renderer?.destroy();
      }
      agent.dispose();
    };

    // Ctrl+C exits cleanly without corrupting state
    const sigintHandler = () => {
      cleanup();
      process.exit(0);
    };
    process.on("SIGINT", sigintHandler);

    try {
      type FinalizeYield = "quit" | "execute";

      // Yield loop: FinalizeApp yields back to cmdFinalize for fix execution
      // (parallel or serial TUI), then we remount FinalizeApp at recheck/PR phase.
      let running = true;
      while (running) {
        const action = await new Promise<FinalizeYield>((resolve) => {
          root!.render(
            <tui.FinalizeApp
              orchestrator={orchestrator}
              agent={agent}
              config={config}
              sessionPaths={plan!.paths}
              cwd={cwd}
              onQuit={() => resolve("quit")}
              onExecute={() => resolve("execute")}
            />,
          );
        });

        if (action === "quit") {
          running = false;
          break;
        }

        if (action === "execute") {
          const { fixTasksToTasks } = await import("../finalize/fix-converter.js");
          const { buildFixTuiData } = await import("../finalize/parallel-bridge.js");

          const fixes = orchestrator.getConfirmedFixes();
          const tasks = fixTasksToTasks(fixes, cwd);
          const { analyzeTaskGraph } = await loadParallelCoordinator();
          const analysis = analyzeTaskGraph(tasks);
          const useParallel = tasks.length >= 3 && analysis.recommendParallel;

          if (useParallel) {
            // ── Parallel execution TUI ──
            const { createInitialTuiState, applyParallelEvent, attachParallelLogger } = await import("../finalize/parallel-bridge.js");
            const { ParallelCoordinator } = await loadParallelCoordinator();

            const coordinator = new ParallelCoordinator({
              tasks,
              repoRoot: cwd,
              project: config.project.name,
              sessionPaths: plan!.paths,
              config: {
                maxWorkers: config.parallel?.max_workers ?? 4,
                aiConflictResolution: config.parallel?.ai_conflict_resolution,
                maxRequeueCount: config.parallel?.max_requeue_count,
              },
              synthConfig: config,
              agent,
              fallbackAgent: null,
            });

            const { ParallelBridge } = await import("../tui/ParallelBridge.js");
            const tuiData = buildFixTuiData(tasks, config, plan!.metadata.id, "Parallel fix execution");
            const parallelState = createInitialTuiState(tasks.length);
            let parallelDestroyed = false;

            // Render ONCE — the bridge manages its own re-renders via _notify
            root!.render(
              <ParallelBridge
                tuiData={tuiData}
                parallelState={parallelState}
                taskGraphAnalysis={analysis}
                onQuit={() => coordinator.abort()}
              />,
            );

            let parallelRenderScheduled = false;
            const notifyParallelTuiThrottled = () => {
              if (parallelDestroyed || parallelRenderScheduled) return;
              parallelRenderScheduled = true;
              setTimeout(() => {
                parallelRenderScheduled = false;
                if (!parallelDestroyed) tuiData._notify?.();
              }, 16);
            };

            attachParallelLogger(coordinator.on.bind(coordinator), plan!.paths.logs);

            coordinator.on((event) => {
              applyParallelEvent(event, parallelState, () =>
                coordinator.getWorkerDisplayStates(),
              );
              if (event.type === "worker:output" && "taskId" in event) {
                const taskId = event.taskId;
                tuiData.taskOutputMap[taskId] = (tuiData.taskOutputMap[taskId] ?? "") + event.message;
              }
              notifyParallelTuiThrottled();
            });

            process.off("SIGINT", sigintHandler);
            let result;
            try {
              result = await coordinator.run();
            } finally {
              parallelDestroyed = true;
              process.on("SIGINT", sigintHandler);
            }

            if (result.serial) {
              await orchestrator.executeFixes(agent, config, plan!.paths, () => {});
            } else {
              await orchestrator.completeFixExecution(
                result.mergedTaskIds.length,
                result.failedTaskIds.length,
                agent,
                config,
                plan!.paths,
                () => {},
              );
            }
          } else {
            // ── Serial execution TUI ──
            const { SerialBridge } = await import("../tui/ParallelBridge.js");
            const tuiData = buildFixTuiData(tasks, config, plan!.metadata.id, "Serial fix execution");
            let serialDestroyed = false;

            // Render ONCE — the bridge manages its own re-renders via _notify
            root!.render(
              <SerialBridge
                tuiData={tuiData}
                onQuit={() => {
                  cleanup();
                  process.exit(0);
                }}
              />,
            );

            let serialRenderScheduled = false;
            const notifySerialTuiThrottled = () => {
              if (serialDestroyed || serialRenderScheduled) return;
              serialRenderScheduled = true;
              setTimeout(() => {
                serialRenderScheduled = false;
                if (!serialDestroyed) tuiData._notify?.();
              }, 16);
            };

            // Run fixes serially, updating TUI state as each fix progresses
            await orchestrator.executeFixes(agent, config, plan!.paths, (msg) => {
              // Map orchestrator messages to TUI task state updates
              const executing = /^Executing fix (\d+)\/\d+: (.*)/.exec(msg.content);
              if (executing) {
                const idx = parseInt(executing[1], 10) - 1;
                if (tasks[idx]) {
                  tuiData.currentTaskId = tasks[idx].id;
                  tuiData.isThinking = true;
                  tuiData.currentPhase = `Fix ${executing[1]}/${tasks.length}`;
                  tuiData.phaseStartTime = Date.now();
                  const task = tuiData.tasks.find((t) => t.id === tasks[idx].id);
                  if (task) task.status = "in_progress";
                  tuiData.taskStartTimes[tasks[idx].id] = Date.now();
                }
              }

              const complete = /^Fix (\d+)\/\d+ complete/.exec(msg.content);
              if (complete) {
                const idx = parseInt(complete[1], 10) - 1;
                if (tasks[idx]) {
                  const task = tuiData.tasks.find((t) => t.id === tasks[idx].id);
                  if (task) task.status = "done";
                  tuiData.isThinking = false;
                  const startTime = tuiData.taskStartTimes[tasks[idx].id];
                  if (startTime) tuiData.taskElapsedMs[tasks[idx].id] = Date.now() - startTime;
                }
              }

              const failed = /^Fix (\d+)\/\d+ failed/.exec(msg.content);
              if (failed) {
                const idx = parseInt(failed[1], 10) - 1;
                if (tasks[idx]) {
                  const task = tuiData.tasks.find((t) => t.id === tasks[idx].id);
                  if (task) task.status = "failed";
                  tuiData.isThinking = false;
                }
              }

              notifySerialTuiThrottled();
            });

            serialDestroyed = true;
          }

          // Loop back → remounts FinalizeApp at recheck/PR phase
          continue;
        }
      }
    } finally {
      process.off("SIGINT", sigintHandler);
      cleanup();
    }
  } else {
    // ── Non-TUI: automated finalize pipeline ──
    log(`${fmt.bold("synth")} ${ansi.muted}─ finalize ─${ansi.reset} ${plan.metadata.id}\n`);

    const [{ getAgent }, { finalize }] = await Promise.all([
      loadAgentRegistry(),
      loadFinalize(),
    ]);
    const agent = getAgent(config.agent.name);

    const result = await finalize(config, agent, plan.paths, cwd);
    agent.dispose();

    if (result.blocked) {
      logError(`Blocked: ${result.blockReason}`);
      process.exit(1);
    }

    if (result.findings.length > 0) {
      log(`\n${fmt.bold("Review findings:")}`);
      const severityIcon: Record<string, string> = {
        critical: `${ansi.error}✗${ansi.reset}`,
        warning: `${ansi.warning}▲${ansi.reset}`,
        info: `${ansi.muted}●${ansi.reset}`,
      };
      for (const f of result.findings) {
        const icon = severityIcon[f.severity] ?? severityIcon.info;
        log(`  ${icon} ${ansi.muted}[${f.perspective}]${ansi.reset} ${f.message}`);
      }
    }

    if (result.prUrl) {
      logSuccess(`PR created: ${result.prUrl}`);
      await updateSessionMetadata(cwd, plan.metadata.id, { status: "finalized" });
    }
  }
}
