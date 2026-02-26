import { join } from "node:path";
import type { CommandModule } from "yargs";
import {
  getSession,
  getMostRecentSession,
  listSessions,
  updateSessionMetadata,
} from "../sessions/registry.js";
import type { SessionPaths } from "../sessions/types.js";
import { loadTasks, saveTasks, resetOrphanedTasks, allTasksDone, getProgress } from "../tasks/store.js";
import { fileExists, readJson, writeJson, writeText, removeFile } from "../utils/fs.js";
import { ansi, fmt, PRIORITY_COLORS } from "../tui/theme.js";
import { deriveSessionSlug, deriveTaskPrefix } from "../sessions/slug.js";
import type { TuiContext, TuiEngineData, CompletionSummary } from "../tui/types.js";
import type { BackgroundAuditController, BackgroundAuditState, BackgroundAuditStatus, FinalizeMessage, OrchestratorState } from "../finalize/chat-types.js";
import { spawn } from "../utils/process.js";
import { formatToolEvent } from "../utils/tool-format.js";
import { getLogger } from "../logging/logger.js";
import { checkoutBranch, getCurrentBranch } from "../utils/git.js";

import {
  log,
  logError,
  logSuccess,
  applyTheme,
  loadAgentRegistry,
  loadEngine,
  loadRunModule,
  loadReviewOrchestrator,
  loadTui,
  loadInterviewer,
  loadPlanner,
} from "./helpers.js";

import { cmdRun } from "./run.js";
import { cmdFinalize } from "./finalize.js";

// ── Local helpers ──

async function resolvePlanId(input: string | undefined, cwd: string): Promise<string | undefined> {
  if (!input) return undefined;
  if (/^\d+$/.test(input)) {
    const allPlans = await listSessions(cwd);
    const plans = allPlans.filter((p) => p.status !== "completed" && p.status !== "finalized");
    const idx = parseInt(input, 10) - 1;
    if (idx < 0 || idx >= plans.length) {
      if (idx >= 0 && idx < allPlans.length) {
        const session = allPlans[idx];
        logError(`Session #${input} is already ${session.status}. Run 'synth ls --all' to see all sessions.`);
      } else {
        logError(`Session #${input} not found. Run 'synth ls' to see available sessions.`);
      }
      process.exit(1);
    }
    return plans[idx].id;
  }
  return input;
}

async function setSessionSlugAndPrefix(cwd: string, sessionId: string, title: string): Promise<string> {
  const slug = deriveSessionSlug(title);
  await updateSessionMetadata(cwd, sessionId, { description: title, slug });
  return deriveTaskPrefix(title);
}

function createBackgroundAudit() {
  let state: BackgroundAuditState = { status: "running", buffer: "" };
  const listeners = new Set<(next: BackgroundAuditState) => void>();

  const notify = () => {
    for (const listener of listeners) listener(state);
  };

  const controller: BackgroundAuditController = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const appendChunk = (chunk: string) => {
    if (!chunk) return;
    state = { ...state, buffer: state.buffer + chunk };
    notify();
  };

  const setStatus = (status: BackgroundAuditStatus, error?: string) => {
    state = { ...state, status, error };
    notify();
  };

  return { controller, appendChunk, setStatus };
}

// ── Resume interview helper ──

async function resumeInterview(
  plan: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  savedState: import("../interview/types.js").InterviewState,
  cwd: string,
  tuiEnabled: boolean,
  localCmdRun: (sessionId?: string, startIteration?: number, tuiContext?: TuiContext) => Promise<void>,
  restoreBranch?: () => Promise<void>,
): Promise<void> {
  const config = await applyTheme(cwd);
  if (plan.metadata.agentName && plan.metadata.agentName !== config.agent.name) {
    config.agent.name = plan.metadata.agentName;
    config.agent.model = undefined;
  }
  const showToolLogs = config.tui?.show_tool_logs !== false;
  const logger = getLogger();

  const [{ getAgent }, interviewMod, { generateTasks }] = await Promise.all([
    loadAgentRegistry(),
    loadInterviewer(),
    loadPlanner(),
  ]);

  const agent = getAgent(config.agent.name);

  let prdMarkdown: string | null = null;
  const { id, paths } = { id: plan.metadata.id, paths: plan.paths };

  const interviewer = new interviewMod.Interviewer(agent, cwd, config.agent.model, async (messages) => {
    const state: import("../interview/types.js").InterviewState = {
      messages: messages as import("../interview/types.js").InterviewMessage[],
      interviewerHistory: messages as import("../interview/types.js").InterviewMessage[],
      prdPending: !prdMarkdown,
    };
    await writeJson(paths.interview, state);
  });
  interviewer.restoreHistory(savedState.interviewerHistory);

  if (tuiEnabled) {
    const tui = await loadTui();
    const planRenderer = await tui.createCliRenderer({
      exitOnCtrlC: false,
      useKittyKeyboard: { disambiguate: true, alternateKeys: true },
    });
    const planRoot = tui.createRoot(planRenderer);

    const cleanup = () => {
      planRoot.unmount();
      planRenderer.destroy();
    };

    const sigintHandler = () => {
      cleanup();
      agent.dispose();
      if (restoreBranch) {
        void restoreBranch().finally(() => process.exit(0));
        return;
      }
      process.exit(0);
    };
    process.on("SIGINT", sigintHandler);

    // Resume interview with saved messages
    logger.info("interview:resume", "Interview resumed", { sessionId: id });
    const interviewResult = await new Promise<boolean>((resolve) => {
      planRoot.render(
        <tui.InterviewApp
          sessionId={id}
          initialMessages={savedState.messages.length > 0 ? savedState.messages : savedState.interviewerHistory}
          onSendMessage={async (msg, onChunk, onTool, onReset) => {
            logger.info("interview:prompt", "User message", { length: msg.length });
            try {
              const response = await interviewer.respond(msg, onChunk, showToolLogs ? onTool : undefined, onReset);
              logger.info("interview:response", "Assistant response", { length: response.length });
              if (!response.trim()) {
                logger.warn("interview:empty-response", "Assistant returned empty response");
              }
              const extractedMd = interviewer.extractPrdMarkdown(response);
              if (extractedMd) {
                prdMarkdown = extractedMd;
                logger.info("prd:extracted", "PRD detected in interview response", { length: extractedMd.length });
              }
              return { response, done: !!extractedMd };
            } catch (err) {
              logger.error("interview:error", "Interview failed", { error: err instanceof Error ? err.message : String(err) });
              throw err;
            }
          }}
          onPersistMessages={async (messages) => {
            const state: import("../interview/types.js").InterviewState = {
              messages,
              interviewerHistory: interviewer.getHistory(),
              prdPending: !prdMarkdown,
            };
            await writeJson(paths.interview, state);
          }}
          onComplete={() => resolve(true)}
          onQuit={() => resolve(false)}
        />,
      );
    });

    if (!interviewResult) {
      logger.info("interview:quit", "Interview quit", { sessionId: id });
      process.off("SIGINT", sigintHandler);
      cleanup();
      agent.dispose();
      await restoreBranch?.();
      return;
    }

    if (!prdMarkdown) {
      logger.warn("prd:missing", "No PRD extracted from interview");
      process.off("SIGINT", sigintHandler);
      cleanup();
      agent.dispose();
      await restoreBranch?.();
      return;
    }

    // Phase 2: PRD Review (same flow as cmdPlan)
    const taskPrefix = await setSessionSlugAndPrefix(cwd, id, interviewMod.extractPrdTitle(prdMarkdown));

    logger.info("prd:review-start", "PRD review started", { sessionId: id });
    let approvedPrdContent: string | null = null;
    const prdApproved = await new Promise<boolean>((resolve) => {
      planRoot.render(
        <tui.PrdReviewView
          prdMarkdown={prdMarkdown!}
          agent={agent}
          cwd={cwd}
          model={config.agent.model}
          showToolLogs={showToolLogs}
          onApprove={(finalizedPrd) => {
            approvedPrdContent = finalizedPrd;
            logger.info("prd:approved", "PRD approved", { length: finalizedPrd.length });
            resolve(true);
          }}
          onQuit={() => {
            logger.info("prd:review-quit", "PRD review quit", { sessionId: id });
            resolve(false);
          }}
        />,
      );
    });

    if (!prdApproved || !approvedPrdContent) {
      logger.info("prd:review-cancelled", "PRD review cancelled", { sessionId: id });
      process.off("SIGINT", sigintHandler);
      cleanup();
      agent.dispose();
      log(`\nSession saved. Resume later with: ${fmt.bold(`synth resume ${id}`)}`);
      await restoreBranch?.();
      return;
    }

    // Pipeline: write finalized PRD to disk before task generation
    await writeText(paths.prd, approvedPrdContent);

    // Pipeline: generate tasks only after PRD is finalized and persisted
    let streamOutput = "";
    let taskCount = 0;
    let phaseStartTime = Date.now();
    planRoot.render(<tui.GeneratingView output={streamOutput} phaseStartTime={phaseStartTime} />);

    let taskFile;
    logger.info("tasks:generate-start", "Generating tasks from PRD", { sessionId: id });
    try {
      taskFile = await generateTasks(
        agent, paths.prd, config.project.name, config.project.branch || `synth/${id}`, cwd,
        {
          model: config.agent.model,
          taskPrefix,
          onProgress: (chunk) => {
            streamOutput += chunk;
            const ids = streamOutput.match(/\b[A-Z]{2,5}-\d{3}\b/g);
            taskCount = ids ? new Set(ids).size : 0;
            planRoot.render(<tui.GeneratingView output={streamOutput} taskCount={taskCount} phaseStartTime={phaseStartTime} />);
          },
          onTool: showToolLogs
            ? (event) => {
              streamOutput += `\n${formatToolEvent(event)}\n`;
              planRoot.render(<tui.GeneratingView output={streamOutput} taskCount={taskCount} phaseStartTime={phaseStartTime} />);
            }
            : undefined,
        },
      );
    } catch (err) {
      logger.error("tasks:generate-error", "Task generation failed", { error: err instanceof Error ? err.message : String(err) });
      process.off("SIGINT", sigintHandler);
      cleanup();
      agent.dispose();
      throw err;
    }
    logger.info("tasks:generate-complete", "Task generation complete", { count: taskFile.tasks.length });

    await saveTasks(paths.tasks, taskFile);
    await writeText(paths.progress, "## Codebase Patterns\n\n---\n\n");
    await updateSessionMetadata(cwd, id, {
      status: "planning",
      taskCount: taskFile.tasks.length,
    });

    // Phase 3: Task Review
    const confirmed = await new Promise<boolean>((resolve) => {
      planRoot.render(
        <tui.ReviewView
          tasks={taskFile.tasks}
          sessionId={id}
          onConfirm={() => {
            logger.info("tasks:review-confirmed", "Task review confirmed", { sessionId: id });
            resolve(true);
          }}
          onDecline={() => {
            logger.info("tasks:review-declined", "Task review declined", { sessionId: id });
            resolve(false);
          }}
        />,
      );
    });

    process.off("SIGINT", sigintHandler);

    if (!confirmed) {
      logger.info("tasks:review-cancelled", "Task review cancelled", { sessionId: id });
      cleanup();
      agent.dispose();
      log(`\nSession saved. Resume later with: ${fmt.bold(`synth resume ${id}`)}`);
      await restoreBranch?.();
      return;
    }

    // Phase 4: Execution (reuse renderer+root)
    agent.dispose();
    await localCmdRun(id, 0, { renderer: planRenderer, root: planRoot });
    cleanup();
  } else {
    // Non-TUI resume path
    // Show restored conversation
    log(`\n${ansi.muted}--- Restored conversation (${savedState.interviewerHistory.length} messages) ---${ansi.reset}`);
    for (const msg of savedState.interviewerHistory) {
      const label = msg.role === "user" ? `${ansi.primary}You` : `${ansi.magenta}Synth`;
      log(`\n${label}:${ansi.reset}`);
      log(msg.content);
    }
    log(`${ansi.muted}--- End of restored conversation ---${ansi.reset}\n`);

    log(`${ansi.magenta}Synth:${ansi.reset}`);
    log("Continuing the interview from where we left off. What else would you like to add?\n");
    logger.info("interview:resume", "Interview resumed", { sessionId: id });

    const readline = await import("node:readline");
    const askQuestion = (): Promise<string | null> => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => {
        rl.question(`\n${ansi.primary}You:${ansi.reset} `, (answer) => {
          rl.close();
          if (answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") {
            resolve(null);
          } else {
            resolve(answer);
          }
        });
      });
    };

    while (!prdMarkdown) {
      const userInput = await askQuestion();
      if (userInput === null) {
        logger.info("interview:quit", "Interview quit", { sessionId: id });
        agent.dispose();
        await restoreBranch?.();
        return;
      }

      logger.info("interview:prompt", "User message", { length: userInput.length });
      const response = await interviewer.respond(userInput);
      logger.info("interview:response", "Assistant response", { length: response.length });
      if (!response.trim()) {
        logger.warn("interview:empty-response", "Assistant returned empty response");
      }
      log(`\n${ansi.magenta}Synth:${ansi.reset}`);
      log(response);
      prdMarkdown = interviewer.extractPrdMarkdown(response);
      if (prdMarkdown) {
        logger.info("prd:extracted", "PRD detected in interview response", { length: prdMarkdown.length });
      }

      if (prdMarkdown) {
        log(`\n${ansi.primary}Does this all look good? Press Enter to generate the PRD, or type feedback to refine.${ansi.reset}`);
        const confirmation = await askQuestion();
        if (confirmation === null) {
          agent.dispose();
          await restoreBranch?.();
          return;
        }
        if (confirmation.trim()) {
          prdMarkdown = null;
          logger.info("interview:prompt", "User message", { length: confirmation.length });
          const refinement = await interviewer.respond(confirmation);
          logger.info("interview:response", "Assistant response", { length: refinement.length });
          if (!refinement.trim()) {
            logger.warn("interview:empty-response", "Assistant returned empty response");
          }
          log(`\n${ansi.magenta}Synth:${ansi.reset}`);
          log(refinement);
          prdMarkdown = interviewer.extractPrdMarkdown(refinement);
          if (prdMarkdown) {
            logger.info("prd:extracted", "PRD detected in interview response", { length: prdMarkdown.length });
          }
        }
      }
    }

    // Continue with task generation
    logger.info("prd:approved", "PRD confirmed", { length: prdMarkdown.length });
    await writeText(paths.prd, prdMarkdown);
    const taskPrefix = await setSessionSlugAndPrefix(cwd, id, interviewMod.extractPrdTitle(prdMarkdown));

    logSuccess(`PRD saved to ${paths.prd}`);

    log("Generating tasks...\n");
    logger.info("tasks:generate-start", "Generating tasks from PRD", { sessionId: id });
    let taskFile;
    try {
      taskFile = await generateTasks(agent, paths.prd, config.project.name, config.project.branch || `synth/${id}`, cwd, {
        model: config.agent.model,
        taskPrefix,
        onTool: showToolLogs
          ? (event) => {
            log(formatToolEvent(event));
          }
          : undefined,
      });
    } catch (err) {
      logger.error("tasks:generate-error", "Task generation failed", { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    logger.info("tasks:generate-complete", "Task generation complete", { count: taskFile.tasks.length });

    await saveTasks(paths.tasks, taskFile);
    await writeText(paths.progress, "## Codebase Patterns\n\n---\n\n");
    await updateSessionMetadata(cwd, id, {
      status: "planning",
      taskCount: taskFile.tasks.length,
    });

    log(fmt.bold(`Generated ${taskFile.tasks.length} tasks:`) + "\n");
    for (const task of taskFile.tasks) {
      const priorityColor = PRIORITY_COLORS[task.priority] ?? ansi.muted;
      log(`  ${priorityColor}P${task.priority}${ansi.reset} ${task.id} ${task.title}`);
    }

    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl2.question(`\nStart executing? (Y/n) `, resolve);
    });
    rl2.close();

    agent.dispose();

    if (!answer || answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
      logger.info("run:auto-start", "Execution requested", { sessionId: id });
      await localCmdRun(id);
    } else {
      logger.info("run:deferred", "Execution deferred", { sessionId: id });
      log(`\nSession saved. Resume later with: ${fmt.bold(`synth resume ${id}`)}`);
    }
  }
}

// ── Main exported function ──

export async function cmdResumeInternal(
  sessionId: string | undefined,
  cwd: string,
  tuiEnabled: boolean,
  parallelMode: boolean,
  parallelWorkers: number | undefined,
  agentName?: string,
): Promise<void> {
  const baseConfig = await applyTheme(cwd);
  const showToolLogs = baseConfig.tui?.show_tool_logs !== false;
  const originalBranch = await getCurrentBranch(cwd).catch(() => null);
  const restoreOriginalBranch = async () => {
    if (!originalBranch) return;
    try {
      await checkoutBranch(originalBranch, cwd);
    } catch (err) {
      log(fmt.warn(`Failed to restore branch '${originalBranch}': ${err instanceof Error ? err.message : String(err)}`));
    }
  };
  // Build local cmdFinalize wrapper
  const localCmdFinalize = (
    sid?: string,
    tuiContext?: TuiContext,
    runContext?: { config: import("../config/types.js").SynthConfig; sessionPaths: SessionPaths },
    savedConversation?: import("../finalize/chat-types.js").FinalizeMessage[],
    savedState?: import("../finalize/chat-types.js").OrchestratorState,
    ctx?: import("./finalize.js").CliContext,
    options?: import("./finalize.js").FinalizeUiOptions,
  ) => cmdFinalize(sid, tuiContext, runContext, savedConversation, savedState, ctx ?? { cwd, tuiEnabled }, options);

  // Build local cmdRun wrapper
  const localCmdRun = async (sid?: string, startIteration = 0, tuiContext?: TuiContext) => {
    const config = await applyTheme(cwd);
    // Apply parallel default from config when no explicit CLI flag was given
    let effectiveParallelMode = parallelMode;
    if (!parallelMode && parallelWorkers === undefined) {
      effectiveParallelMode = config.parallel?.enabled ?? true;
    }
    return cmdRun(sid, startIteration, tuiContext, {
      cwd,
      tuiEnabled,
      parallelMode: effectiveParallelMode,
      parallelWorkers,
      cmdFinalize: localCmdFinalize,
    });
  };

  let plan;
  if (sessionId) {
    plan = await getSession(cwd, sessionId);
  } else {
    plan = await getMostRecentSession(cwd);
  }

  if (!plan) {
    logError("No session found to resume.");
    process.exit(1);
  }

  if (agentName && agentName !== plan.metadata.agentName) {
    await updateSessionMetadata(cwd, plan.metadata.id, { agentName });
    plan.metadata.agentName = agentName;
  }

  // Guard: check worktree mismatch
  if (plan.metadata.worktreePath) {
    const worktreeExists = await fileExists(join(plan.metadata.worktreePath, ".git"));
    if (!worktreeExists) {
      log(fmt.warn(`Worktree at ${plan.metadata.worktreePath} no longer exists. Resuming from current directory.`));
      await updateSessionMetadata(cwd, plan.metadata.id, { worktreePath: undefined, branch: undefined });
    } else if (process.cwd() !== plan.metadata.worktreePath) {
      logError(`Session ${plan.metadata.id} is tied to worktree at ${plan.metadata.worktreePath}.\nRun from that directory: cd ${plan.metadata.worktreePath} && synth resume ${plan.metadata.id}`);
      process.exit(1);
    }
  }

  const status = plan.metadata.status;
  const id = plan.metadata.id;

  switch (status) {
    case "interviewing": {
      const savedState: import("../interview/types.js").InterviewState = (await fileExists(plan.paths.interview))
        ? await readJson<import("../interview/types.js").InterviewState>(plan.paths.interview)
        : { messages: [], interviewerHistory: [], prdPending: true };
      if (savedState.prdPending) {
        const msgCount = savedState.interviewerHistory.length;
        log(fmt.info(msgCount > 0
          ? `Resuming interview for session ${id} (${msgCount} messages saved)`
          : `Starting fresh interview for session ${id}`));
        await resumeInterview(plan, savedState, cwd, tuiEnabled, localCmdRun, restoreOriginalBranch);
        return;
      }
      // Interview is done but status wasn't updated — fall through to execution
      break;
    }

    case "finalizing": {
      const finalizePath = join(plan.paths.root, "finalize-conversation.json");
      if (!(await fileExists(finalizePath))) {
        logError(`Finalize conversation state missing for session ${id}. Run 'synth resume ${id}' to start a fresh review.`);
        process.exit(1);
      }
      const savedConversation = await readJson<import("../finalize/chat-types.js").FinalizeMessage[]>(finalizePath);
      const statePath = join(plan.paths.root, "finalize-state.json");
      const savedState = (await fileExists(statePath))
        ? await readJson<import("../finalize/chat-types.js").OrchestratorState>(statePath)
        : undefined;
      log(fmt.info(`Resuming finalize review for session ${id} (${savedConversation.length} messages)`));
      await localCmdFinalize(id, undefined, undefined, savedConversation, savedState);
      return;
    }

    case "completed": {
      log(fmt.info(`Session ${id} execution is complete.`));
      const readline = await import("node:readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Create PR? (Y/n) `, resolve);
      });
      rl.close();
      if (!answer || answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
        await localCmdFinalize(id);
      }
      return;
    }

    case "finalized": {
      log(fmt.info(`Session ${id} is already finalized.`));
      return;
    }

    case "failed": {
      logError(`Session ${id} has failed. Check logs in ${plan.paths.logs} for details.`);
      return;
    }

    case "blocked": {
      logError(`Session ${id} is blocked. Check logs in ${plan.paths.logs} for details.`);
      return;
    }

    case "reviewing": {
      const config = await applyTheme(cwd);
      if (plan.metadata.agentName && plan.metadata.agentName !== config.agent.name) {
        config.agent.name = plan.metadata.agentName;
        config.agent.model = undefined;
      }
      const [{ getAgent }, runMod] = await Promise.all([
        loadAgentRegistry(),
        loadRunModule(),
      ]);
      const agent = getAgent(config.agent.name);
      const detection = await agent.detect();
      if (!detection.available) {
        logError(`Agent '${config.agent.name}' not available: ${detection.error}`);
        process.exit(1);
      }

      if (tuiEnabled) {
        const tui = await loadTui();
        const renderer = await tui.createCliRenderer({
          useKittyKeyboard: { disambiguate: true, alternateKeys: true },
        });
        const root = tui.createRoot(renderer);
        const App = tui.App;

        const run = await runMod.loadRun(plan.paths);
        const startedAt = run?.startedAt ? new Date(run.startedAt).getTime() : Date.now();
        const endedAt = run?.endedAt ? new Date(run.endedAt).getTime() : Date.now();
        const durationMs = Math.max(0, endedAt - startedAt);
        const totalIterations = run?.currentIteration ?? 0;

        const currentTasks = await loadTasks(plan.paths.tasks);
        const progress = getProgress(currentTasks);
        const sinceDate = run?.startedAt ?? new Date(startedAt).toISOString();
        const gitResult = spawn({ cmd: ["git", "log", "--oneline", `--since=${sinceDate}`], cwd });
        const { stdout: commitLog } = await gitResult.promise;
        const commits = commitLog.trim() ? commitLog.trim().split("\n") : [];

        const summaryData: CompletionSummary = {
          projectName: config.project.name,
          sessionId: plan.metadata.id,
          agentName: config.agent.name,
          totalDurationMs: durationMs,
          totalIterations,
          tasks: currentTasks.tasks,
          progress,
          commits,
          summaryFilePath: plan.paths.summary,
        };

        const taskElapsedMs = Object.fromEntries(
          currentTasks.tasks
            .filter((t) => t.durationMs != null)
            .map((t) => [t.id, t.durationMs as number]),
        );

        const tuiData: TuiEngineData = {
          engineState: "completed",
          iteration: totalIterations,
          maxIterations: config.execution.max_iterations,
          tasks: [...currentTasks.tasks],
          currentTaskId: null,
          output: "",
          agentName: config.agent.name,
          projectName: config.project.name,
          sessionId: plan.metadata.id,
          startTime: startedAt,
          interviewMessages: [],
          isThinking: false,
          currentPhase: null,
          phaseStartTime: null,
          completionSummary: summaryData,
          taskOutputMap: {},
          taskElapsedMs,
          taskStartTimes: {},
          iterationEntries: [],
          configDisplay: JSON.stringify(config, null, 2),
          tokenUsage: { sessionTotal: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, taskTotals: {}, hasData: false },
          reviewStatus: "running",
        };

        let completionResolve: ((action: "quit" | "finalize" | "review") => void) | null = null;
        let allowFinalize = false;
        let allowReview = true;

        const renderTui = () => {
          root.render(
            <App
              {...tuiData}
              onQuit={() => {
                if (completionResolve) {
                  completionResolve("quit");
                }
              }}
              onFinalize={allowFinalize ? () => completionResolve?.("finalize") : undefined}
              onReviewStart={allowReview ? () => completionResolve?.("review") : undefined}
            />,
          );
        };

        renderTui();

        const { FinalizeOrchestrator } = await import("../finalize/orchestrator.js");
        const reviewOrchestrator = new FinalizeOrchestrator({ mode: "review" });
        const finalizeConvPath = join(plan.paths.root, "finalize-conversation.json");
        const finalizeStatePath = join(plan.paths.root, "finalize-state.json");
        const savedConversation = await fileExists(finalizeConvPath)
          ? await readJson<FinalizeMessage[]>(finalizeConvPath)
          : [];
        const savedState = savedConversation.length > 0 && await fileExists(finalizeStatePath)
          ? await readJson<OrchestratorState>(finalizeStatePath)
          : undefined;

        if (savedConversation.length > 0) {
          reviewOrchestrator.restore(agent, config, plan.paths, cwd, savedConversation, savedState);
          tuiData.reviewStatus = "ready";
          renderTui();
        }

        let backgroundAudit: BackgroundAuditController | undefined;
        if (savedConversation.length === 0) {
          const audit = createBackgroundAudit();
          backgroundAudit = audit.controller;

          reviewOrchestrator.start(agent, config, plan.paths, cwd, (chunk) => {
            audit.appendChunk(chunk);
          }).then(() => {
            audit.setStatus("done");
            tuiData.reviewStatus = "ready";
            renderTui();
          }).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            audit.setStatus("error", message);
            tuiData.reviewStatus = "error";
            tuiData.reviewError = message;
            renderTui();
          });
        }

        let reviewFixesApplied = 0;
        let reviewCompleted = false;

        while (true) {
          const completionAction = await new Promise<"quit" | "finalize" | "review">((resolve) => {
            completionResolve = resolve;
          });
          completionResolve = null;

          if (completionAction === "quit") {
            break;
          }

          if (completionAction === "review") {
            let reviewQuit = false;
            await localCmdFinalize(id, { renderer, root }, {
              config,
              sessionPaths: plan.paths,
            }, undefined, undefined, undefined, {
              mode: "review",
              orchestrator: reviewOrchestrator,
              backgroundAudit,
              onReviewComplete: (result: { fixesApplied: number }) => {
                reviewCompleted = true;
                reviewFixesApplied = result.fixesApplied;
              },
              onReviewQuit: () => {
                reviewQuit = true;
              },
            });

            if (reviewQuit) {
              break;
            }

            if (reviewCompleted) {
              await updateSessionMetadata(cwd, id, { status: "completed" });
              allowFinalize = true;
              allowReview = false;
              tuiData.reviewStatus = "complete";
              tuiData.reviewError = undefined;
              tuiData.completionSummary = { ...summaryData, reviewFixesApplied };
              renderTui();
            }
            continue;
          }

          if (completionAction === "finalize") {
            await localCmdFinalize(id, { renderer, root }, {
              config,
              sessionPaths: plan.paths,
            });
            break;
          }
        }

        root.unmount();
        renderer.destroy();
        agent.dispose();
        return;
      }

      const [{ Engine: EngineClass }] = await Promise.all([
        loadEngine(),
      ]);
      const fallbackAgent = config.agent.fallback
        ? getAgent(config.agent.fallback.name)
        : null;

      if (!(await fileExists(plan.paths.reviewTasks))) {
        await removeFile(plan.paths.reviewFindings);

        log(fmt.info(`Session ${id} review was interrupted before generating tasks — re-running review...`));
        const { ReviewOrchestrator } = await loadReviewOrchestrator();
        const reviewOrchestrator = new ReviewOrchestrator(
          config, agent, fallbackAgent, plan.paths, cwd,
        );

        const onSigInt = () => {
          reviewOrchestrator.stop();
          reviewOrchestrator.cleanupPartialFindings().then(() => process.exit(0));
        };
        const onSigTerm = () => {
          reviewOrchestrator.stop();
          reviewOrchestrator.cleanupPartialFindings().then(() => process.exit(0));
        };
        process.on("SIGINT", onSigInt);
        process.on("SIGTERM", onSigTerm);

        try {
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
              case "agent:tool":
                if (showToolLogs && event.tool) log(formatToolEvent(event.tool));
                break;
            }
          });

          const reviewResult = await reviewOrchestrator.run();
          if (reviewResult.findings.length > 0) {
            log(fmt.info(`Review found ${reviewResult.findings.length} finding(s)${reviewResult.executed ? " — fix tasks executed" : ""}`));
          } else {
            log(fmt.info("Review completed — no issues found"));
          }
          await updateSessionMetadata(cwd, id, { status: "completed" });
        } finally {
          process.off("SIGINT", onSigInt);
          process.off("SIGTERM", onSigTerm);
        }
      } else {
        const reviewTaskFile = await loadTasks(plan.paths.reviewTasks);
        const allDone = allTasksDone(reviewTaskFile);

        if (allDone) {
          log(fmt.info(`Session ${id} review tasks are all done — marking completed.`));
          await updateSessionMetadata(cwd, id, { status: "completed" });
        } else {
          const cleaned = resetOrphanedTasks(reviewTaskFile);
          if (cleaned !== reviewTaskFile) {
            await saveTasks(plan.paths.reviewTasks, cleaned);
            log(fmt.warn("Reset orphaned in_progress review tasks from previous session"));
          }

          const reviewPaths: SessionPaths = {
            ...plan.paths,
            tasks: plan.paths.reviewTasks,
            progress: plan.paths.reviewProgress,
            logs: `${plan.paths.reviewRoot}/logs`,
          };

          log(fmt.info(`Resuming review task execution for session ${id}...`));
          const engine = new EngineClass(config, agent, fallbackAgent, reviewPaths, cwd);

          const onSigInt = () => { engine.stop(); };
          const onSigTerm = () => { engine.stop(); };
          process.on("SIGINT", onSigInt);
          process.on("SIGTERM", onSigTerm);

          try {
            engine.on((event) => {
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
                case "agent:tool":
                  if (showToolLogs && event.tool) log(formatToolEvent(event.tool));
                  break;
              }
            });

            await engine.run();
            log(fmt.info("Review task execution complete."));
            await updateSessionMetadata(cwd, id, { status: "completed" });
          } finally {
            process.off("SIGINT", onSigInt);
            process.off("SIGTERM", onSigTerm);
          }
        }
      }
      return;
    }

    case "executing": {
      const { checkLock } = await loadRunModule();
      const lockStatus = await checkLock(plan.paths);
      if (lockStatus.locked) {
        logError(`Session ${id} is currently running (pid ${lockStatus.lock!.pid}). Cannot resume an active session.`);
        process.exit(1);
      }
      // Lock is stale — session crashed without cleanup. Safe to resume.
      break;
    }

    case "planning": {
      log(fmt.info(`Session ${id} is in planning phase — starting execution.`));
      break; // fall through to execution resume below
    }

    // paused — fall through to execution resume below
  }

  const { loadRun } = await loadRunModule();
  const run = await loadRun(plan.paths);
  if (!run) {
    logError(`No run state found for session ${id}. Run 'synth start' to create a new session.`);
    process.exit(1);
  }

  if (run.status === "completed") {
    log(fmt.info(`Session ${id} execution is complete.`));
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`Create PR? (Y/n) `, resolve);
    });
    rl.close();
    if (!answer || answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
      await localCmdFinalize(id);
    }
    return;
  }

  log(fmt.info(`Resuming session ${id} (iteration ${run.currentIteration})`));
  await localCmdRun(id, run.currentIteration);
}

// ── Yargs CommandModule ──

const resumeCommand: CommandModule<object, { "session-id"?: string }> = {
  command: "resume [session-id]",
  describe: "Resume a paused or interrupted session",
  builder: (yargs) =>
    yargs
      .positional("session-id", {
        type: "string",
        describe: "Session ID, slug, or numeric index to resume",
      })
      .option("agent", {
        type: "string",
        describe: "Override agent for this session (e.g. claude, codex)",
      })
      .example("synth resume", "Resume the most recent session")
      .example("synth resume 2", "Resume session #2")
      .example("synth resume --agent codex", "Resume with a different agent"),
  async handler(argv) {
    const cwd = process.cwd();
    const tuiEnabled = process.stdout.isTTY === true && !process.argv.includes("--no-tui");
    const agentName = argv.agent as string | undefined;

    // Parse --parallel [N] / --no-parallel flags from process.argv
    const processArgs = process.argv.slice(2);
    const noParallelFlag = processArgs.includes("--no-parallel");
    const parallelIndex = processArgs.indexOf("--parallel");
    let parallelMode = false;
    let parallelWorkers: number | undefined;
    if (noParallelFlag) {
      parallelMode = false;
    } else if (parallelIndex !== -1) {
      parallelMode = true;
      const next = processArgs[parallelIndex + 1];
      if (next && /^\d+$/.test(next)) {
        parallelWorkers = parseInt(next, 10);
      }
    }

    const sessionId = await resolvePlanId(argv["session-id"], cwd);
    await cmdResumeInternal(sessionId, cwd, tuiEnabled, parallelMode, parallelWorkers, agentName);
  },
};

export default resumeCommand;
