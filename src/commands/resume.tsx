import { join } from "node:path";
import type { CommandModule } from "yargs";
import {
  getSession,
  getMostRecentSession,
  listSessions,
  updateSessionMetadata,
} from "../sessions/registry.js";
import type { SessionPaths } from "../sessions/types.js";
import { loadTasks, saveTasks, resetOrphanedTasks, allTasksDone } from "../tasks/store.js";
import { fileExists, readJson, writeJson, writeText, removeFile } from "../utils/fs.js";
import { ansi, fmt, PRIORITY_COLORS } from "../tui/theme.js";
import { deriveSessionSlug, deriveTaskPrefix } from "../sessions/slug.js";
import type { TuiContext } from "../tui/types.js";

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

// ── Resume interview helper ──

async function resumeInterview(
  plan: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  savedState: import("../interview/types.js").InterviewState,
  cwd: string,
  tuiEnabled: boolean,
  localCmdRun: (sessionId?: string, startIteration?: number, tuiContext?: TuiContext) => Promise<void>,
): Promise<void> {
  const config = await applyTheme(cwd);

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
      process.exit(0);
    };
    process.on("SIGINT", sigintHandler);

    // Resume interview with saved messages
    const interviewResult = await new Promise<boolean>((resolve) => {
      planRoot.render(
        <tui.InterviewApp
          initialMessages={savedState.interviewerHistory}
          onSendMessage={async (msg, onChunk) => {
            const response = await interviewer.respond(msg, onChunk);
            const extractedMd = interviewer.extractPrdMarkdown(response);
            if (extractedMd) prdMarkdown = extractedMd;
            return { response, done: !!extractedMd };
          }}
          onComplete={() => resolve(true)}
          onQuit={() => resolve(false)}
        />,
      );
    });

    if (!interviewResult) {
      process.off("SIGINT", sigintHandler);
      cleanup();
      agent.dispose();
      return;
    }

    if (!prdMarkdown) {
      process.off("SIGINT", sigintHandler);
      cleanup();
      agent.dispose();
      return;
    }

    // Phase 2: PRD Review (same flow as cmdPlan)
    const taskPrefix = await setSessionSlugAndPrefix(cwd, id, interviewMod.extractPrdTitle(prdMarkdown));

    let approvedPrdContent: string | null = null;
    const prdApproved = await new Promise<boolean>((resolve) => {
      planRoot.render(
        <tui.PrdReviewView
          prdMarkdown={prdMarkdown!}
          agent={agent}
          cwd={cwd}
          model={config.agent.model}
          onApprove={(finalizedPrd) => {
            approvedPrdContent = finalizedPrd;
            resolve(true);
          }}
          onQuit={() => resolve(false)}
        />,
      );
    });

    if (!prdApproved || !approvedPrdContent) {
      process.off("SIGINT", sigintHandler);
      cleanup();
      agent.dispose();
      log(`\nSession saved. Resume later with: ${fmt.bold(`synth resume ${id}`)}`);
      return;
    }

    // Pipeline: write finalized PRD to disk before task generation
    await writeText(paths.prd, approvedPrdContent);

    // Pipeline: generate tasks only after PRD is finalized and persisted
    let streamOutput = "";
    let taskCount = 0;
    planRoot.render(<tui.GeneratingView output={streamOutput} />);

    let taskFile;
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
            planRoot.render(<tui.GeneratingView output={streamOutput} taskCount={taskCount} />);
          },
        },
      );
    } catch (err) {
      process.off("SIGINT", sigintHandler);
      cleanup();
      agent.dispose();
      throw err;
    }

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
          onConfirm={() => resolve(true)}
          onDecline={() => resolve(false)}
        />,
      );
    });

    process.off("SIGINT", sigintHandler);

    if (!confirmed) {
      cleanup();
      agent.dispose();
      log(`\nSession saved. Resume later with: ${fmt.bold(`synth resume ${id}`)}`);
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
        agent.dispose();
        return;
      }

      const response = await interviewer.respond(userInput);
      log(`\n${ansi.magenta}Synth:${ansi.reset}`);
      log(response);
      prdMarkdown = interviewer.extractPrdMarkdown(response);

      if (prdMarkdown) {
        log(`\n${ansi.primary}Does this all look good? Press Enter to generate the PRD, or type feedback to refine.${ansi.reset}`);
        const confirmation = await askQuestion();
        if (confirmation === null) {
          agent.dispose();
          return;
        }
        if (confirmation.trim()) {
          prdMarkdown = null;
          const refinement = await interviewer.respond(confirmation);
          log(`\n${ansi.magenta}Synth:${ansi.reset}`);
          log(refinement);
          prdMarkdown = interviewer.extractPrdMarkdown(refinement);
        }
      }
    }

    // Continue with task generation
    await writeText(paths.prd, prdMarkdown);
    const taskPrefix = await setSessionSlugAndPrefix(cwd, id, interviewMod.extractPrdTitle(prdMarkdown));

    logSuccess(`PRD saved to ${paths.prd}`);

    log("Generating tasks...\n");
    const taskFile = await generateTasks(agent, paths.prd, config.project.name, config.project.branch || `synth/${id}`, cwd, { model: config.agent.model, taskPrefix });

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
      await localCmdRun(id);
    } else {
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
): Promise<void> {
  // Build local cmdFinalize wrapper
  const localCmdFinalize = (
    sid?: string,
    tuiContext?: TuiContext,
    runContext?: { config: import("../config/types.js").SynthConfig; sessionPaths: SessionPaths },
    savedConversation?: import("../finalize/chat-types.js").FinalizeMessage[],
    savedState?: import("../finalize/chat-types.js").OrchestratorState,
  ) => cmdFinalize(sid, tuiContext, runContext, savedConversation, savedState, { cwd, tuiEnabled });

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
        await resumeInterview(plan, savedState, cwd, tuiEnabled, localCmdRun);
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
      const [{ getAgent }, { Engine: EngineClass }] = await Promise.all([
        loadAgentRegistry(),
        loadEngine(),
      ]);
      const agent = getAgent(config.agent.name);
      const detection = await agent.detect();
      if (!detection.available) {
        logError(`Agent '${config.agent.name}' not available: ${detection.error}`);
        process.exit(1);
      }
      const fallbackAgent = config.agent.fallback
        ? getAgent(config.agent.fallback.name)
        : null;

      if (!(await fileExists(plan.paths.reviewTasks))) {
        // No review tasks file — run full review from scratch
        // Clean up any partial findings.md from previous interrupted attempt
        await removeFile(plan.paths.reviewFindings);

        log(fmt.info(`Session ${id} review was interrupted before generating tasks — re-running review...`));
        const { ReviewOrchestrator } = await loadReviewOrchestrator();
        const reviewOrchestrator = new ReviewOrchestrator(
          config, agent, fallbackAgent, plan.paths, cwd,
        );

        // Register signal handlers for clean interruption
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
        // Review tasks file exists — check completion state
        const reviewTaskFile = await loadTasks(plan.paths.reviewTasks);
        const allDone = allTasksDone(reviewTaskFile);

        if (allDone) {
          // All review tasks complete — transition to completed
          log(fmt.info(`Session ${id} review tasks are all done — marking completed.`));
          await updateSessionMetadata(cwd, id, { status: "completed" });
        } else {
          // Incomplete review tasks — resume execution via Engine
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

          // Register signal handlers for clean interruption during review task execution
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
      .example("synth resume", "Resume the most recent session")
      .example("synth resume 2", "Resume session #2"),
  async handler(argv) {
    const cwd = process.cwd();
    const tuiEnabled = process.stdout.isTTY === true && !process.argv.includes("--no-tui");

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
    await cmdResumeInternal(sessionId, cwd, tuiEnabled, parallelMode, parallelWorkers);
  },
};

export default resumeCommand;
