import { getSession, getMostRecentSession } from "../sessions/registry.js";
import { loadTasks } from "../tasks/store.js";
import { fileExists } from "../utils/fs.js";
import type { TuiContext } from "../tui/types.js";
import type { FinalizeUiOptions } from "./finalize.js";
import { ansi, fmt } from "../tui/theme.js";
import { getLogger } from "../logging/logger.js";
import { ExecutionPipeline } from "../pipeline/execution-pipeline.js";
import { TuiAdapter } from "../pipeline/tui-adapter.js";
import { LogAdapter } from "../pipeline/log-adapter.js";
import type { PipelineOptions } from "../pipeline/types.js";
import { log, logError, applyTheme } from "./helpers.js";

export interface CliContext {
  cwd: string;
  tuiEnabled: boolean;
  parallelMode: boolean;
  parallelWorkers: number | undefined;
  cmdFinalize: (
    sessionId?: string,
    tuiContext?: TuiContext,
    runContext?: { config: import("../config/types.js").SynthConfig; sessionPaths: import("../sessions/types.js").SessionPaths },
    savedConversation?: import("../finalize/chat-types.js").FinalizeMessage[],
    savedState?: import("../finalize/chat-types.js").OrchestratorState,
    ctx?: import("./finalize.js").CliContext,
    options?: FinalizeUiOptions,
  ) => Promise<void>;
}

export async function cmdRun(
  sessionId: string | undefined,
  startIteration: number,
  tuiContext: TuiContext | undefined,
  ctx: CliContext,
): Promise<void> {
  const { cwd, tuiEnabled, parallelMode, parallelWorkers, cmdFinalize } = ctx;
  const config = await applyTheme(cwd);
  const logger = getLogger();

  const plan = sessionId
    ? await getSession(cwd, sessionId)
    : await getMostRecentSession(cwd);

  if (!plan) {
    logError("No session found. Run 'synth start' first.");
    process.exit(1);
  }

  if (plan.metadata.agentName && plan.metadata.agentName !== config.agent.name) {
    config.agent.name = plan.metadata.agentName;
    config.agent.model = undefined;
  }

  logger.info("run:start", "Run started", {
    sessionId: plan.metadata.id, startIteration, parallelMode,
  });

  if (!(await fileExists(plan.paths.tasks))) {
    logError(`Session ${plan.metadata.id} has no tasks. Run 'synth start' to generate them.`);
    process.exit(1);
  }

  log(
    `${fmt.bold("synth")} ${ansi.muted}│${ansi.reset} ${fmt.label("session:", plan.metadata.id)} ${ansi.muted}│${ansi.reset} ${fmt.label("agent:", config.agent.name)} ${ansi.muted}│${ansi.reset} ${fmt.label("max:", `${config.execution.max_iterations} iterations`)}`,
  );
  log("");

  const options: PipelineOptions = {
    cwd, sessionId: plan.metadata.id, sessionPaths: plan.paths, config,
    startIteration, parallelMode, parallelWorkers, tuiEnabled,
  };
  const pipeline = new ExecutionPipeline(options);

  let completionAction = "quit" as string;
  pipeline.on((event) => {
    if (event.type === "phase:changed" && event.phase === "finalizing") completionAction = "finalize";
    if (event.type === "log" && event.message.includes("Review requested")) completionAction = "review";
  });

  const taskFile = await loadTasks(plan.paths.tasks);
  let tuiAdapter: TuiAdapter | null = null;
  let logAdapter: LogAdapter | null = null;

  if (tuiEnabled) {
    tuiAdapter = new TuiAdapter(pipeline, {
      tasks: taskFile.tasks, config, sessionId: plan.metadata.id,
      sessionPaths: plan.paths, startIteration, parallelMode,
      getWorkerDisplayStates: () => pipeline.getWorkerDisplayStates(),
    }, tuiContext);
    await tuiAdapter.start();
  } else {
    logAdapter = new LogAdapter(pipeline, { showToolLogs: config.tui?.show_tool_logs !== false });
  }

  await pipeline.run();

  // Handle post-pipeline finalize/review actions
  const tuiCtx = tuiAdapter?.getTuiContext();
  const runContext = { config, sessionPaths: plan.paths };
  if (completionAction === "review" && tuiCtx) {
    await cmdFinalize(plan.metadata.id, tuiCtx, runContext, undefined, undefined, { cwd, tuiEnabled });
  } else if (completionAction === "finalize") {
    await cmdFinalize(plan.metadata.id, tuiCtx ?? undefined, tuiCtx ? runContext : undefined);
  }

  tuiAdapter?.cleanup();
  logAdapter?.dispose();

  // Send notifications
  const state = pipeline.getState();
  const notificationsEnabled = config.notifications?.enabled !== false && process.stdout.isTTY === true;
  if (notificationsEnabled) {
    const notif = await import("../notifications.js");
    if (state.summary && !state.error) {
      notif.sendCompletionNotification({
        durationMs: state.summary.totalDurationMs, taskCount: state.summary.progress.done,
      });
    } else if (state.error) {
      notif.sendErrorNotification({
        errorSummary: state.error.message,
        tasksCompleted: state.summary?.progress.done ?? 0,
        durationMs: state.summary?.totalDurationMs ?? 0,
      });
    }
  }
}
