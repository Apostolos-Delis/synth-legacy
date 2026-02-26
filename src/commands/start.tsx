import { join } from "node:path";
import type { CommandModule } from "yargs";
import type { InterviewState, InterviewMessage } from "../interview/types.js";
import {
  createSession,
  getSession,
  updateSessionMetadata,
} from "../sessions/registry.js";
import { deriveSessionSlug, deriveTaskPrefix } from "../sessions/slug.js";
import { saveTasks, loadTasks, getProgress } from "../tasks/store.js";
import { writeText, readText, fileExists, writeJson } from "../utils/fs.js";
import { spawn } from "../utils/process.js";
import { formatToolEvent } from "../utils/tool-format.js";
import { ansi, fmt, PRIORITY_COLORS } from "../tui/theme.js";
import { createSpinner } from "../tui/spinner.js";
import { getLogger } from "../logging/logger.js";

import { cmdRun, type CliContext as RunCliContext } from "./run.js";
import { cmdFinalize } from "./finalize.js";
import {
  log,
  logError,
  logSuccess,
  applyTheme,
  loadAgentRegistry,
  loadInterviewer,
  loadPlanner,
  loadTui,
} from "./helpers.js";

// ── Context for callers ──

export interface StartContext {
  cwd: string;
  tuiEnabled: boolean;
  parallelMode: boolean;
  parallelWorkers: number | undefined;
  agentName?: string;
}

// ── Exported helpers ──

export function parseWorktreeFlag(argv: string[]): { useWorktree: boolean; explicitName?: string } {
  const wIndex = argv.indexOf("-w") !== -1 ? argv.indexOf("-w") : argv.indexOf("--worktree");
  if (wIndex === -1) return { useWorktree: false };
  const next = argv[wIndex + 1];
  if (next && !next.startsWith("-")) {
    return { useWorktree: true, explicitName: next };
  }
  return { useWorktree: true };
}

// ── Internal helpers ──

async function renameWorktreeBranch(
  currentBranch: string,
  prdTitle: string,
  sessionId: string,
  workingDir: string,
): Promise<string> {
  const newBranch = `synth/${deriveSessionSlug(prdTitle)}`;
  if (newBranch === currentBranch) return currentBranch;
  const result = await (spawn({ cmd: ["git", "branch", "-m", currentBranch, newBranch], cwd: workingDir })).promise;
  if (result.exitCode === 0) {
    await updateSessionMetadata(workingDir, sessionId, { branch: newBranch });
    return newBranch;
  }
  return currentBranch;
}

async function createWorktreeForSession(
  repoRoot: string,
  wtName: string,
  tuiEnabled: boolean,
): Promise<{ wtPath: string; branchName: string }> {
  const branchName = `synth/${wtName}`;
  const wtPath = join(repoRoot, ".worktrees", wtName);

  if (tuiEnabled) {
    const spinner = createSpinner("Creating worktree");
    const result = await (spawn({ cmd: ["git", "worktree", "add", wtPath, "-b", branchName], cwd: repoRoot })).promise;
    if (result.exitCode !== 0) {
      spinner.stop(fmt.error(`Failed to create worktree: ${result.stderr}`));
      process.exit(1);
    }
    spinner.stop(fmt.success(`Worktree created at ${wtPath}`));
  } else {
    log("Creating worktree...");
    const result = await (spawn({ cmd: ["git", "worktree", "add", wtPath, "-b", branchName], cwd: repoRoot })).promise;
    if (result.exitCode !== 0) {
      logError(`Failed to create worktree: ${result.stderr}`);
      process.exit(1);
    }
    logSuccess(`Worktree created at ${wtPath}`);
  }

  return { wtPath, branchName };
}

async function setSessionSlugAndPrefix(cwd: string, sessionId: string, title: string): Promise<string> {
  const slug = deriveSessionSlug(title);
  await updateSessionMetadata(cwd, sessionId, { description: title, slug });
  return deriveTaskPrefix(title);
}

function buildRunContext(ctx: StartContext): RunCliContext {
  return {
    cwd: ctx.cwd,
    tuiEnabled: ctx.tuiEnabled,
    parallelMode: ctx.parallelMode,
    parallelWorkers: ctx.parallelWorkers,
    cmdFinalize: (sessionId, tuiContext, runContext) =>
      cmdFinalize(sessionId, tuiContext, runContext),
  };
}

// ── Resume interview (exported for use by cmdResume) ──

export async function resumeInterview(
  plan: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  savedState: InterviewState,
  ctx: StartContext,
): Promise<void> {
  const { cwd, tuiEnabled } = ctx;
  const config = await applyTheme(cwd);
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
    const state: InterviewState = {
      messages: messages as InterviewMessage[],
      interviewerHistory: messages as InterviewMessage[],
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
          sessionId={id}
          initialMessages={savedState.interviewerHistory}
          onSendMessage={async (msg, onChunk, onTool, onReset) => {
            const response = await interviewer.respond(msg, onChunk, showToolLogs ? onTool : undefined, onReset);
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
      logger.info("interview:quit", "Interview quit", { sessionId: id });
      process.off("SIGINT", sigintHandler);
      cleanup();
      agent.dispose();
      return;
    }

    if (!prdMarkdown) {
      logger.warn("prd:missing", "No PRD extracted from interview");
      process.off("SIGINT", sigintHandler);
      cleanup();
      agent.dispose();
      return;
    }

    // Phase 2: PRD Review (same flow as cmdStart)
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
      cleanup();
      agent.dispose();
      log(`\nSession saved. Resume later with: ${fmt.bold(`synth resume ${id}`)}`);
      return;
    }

    // Phase 4: Execution (reuse renderer+root)
    agent.dispose();
    await cmdRun(id, 0, { renderer: planRenderer, root: planRoot }, buildRunContext(ctx));
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
    const taskFile = await generateTasks(agent, paths.prd, config.project.name, config.project.branch || `synth/${id}`, cwd, {
      model: config.agent.model,
      taskPrefix,
      onTool: showToolLogs
        ? (event) => {
          log(formatToolEvent(event));
        }
        : undefined,
    });

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
      await cmdRun(id, 0, undefined, buildRunContext(ctx));
    } else {
      log(`\nSession saved. Resume later with: ${fmt.bold(`synth resume ${id}`)}`);
    }
  }
}

// ── Main start command logic ──

export async function cmdStart(
  sessionIdOrFlag: string | undefined,
  ctx: StartContext,
): Promise<void> {
  const { cwd, tuiEnabled } = ctx;
  const config = await applyTheme(cwd);
  const defaultAgentName = config.agent.name;
  const agentName = ctx.agentName ?? config.agent.name;
  if (agentName !== defaultAgentName) {
    config.agent.name = agentName;
    config.agent.model = undefined;
  }
  const showToolLogs = config.tui?.show_tool_logs !== false;
  const repoRoot = cwd;
  let sessionCwd = cwd;

  const { useWorktree, explicitName: explicitWorktreeName } = parseWorktreeFlag(process.argv.slice(2));

  const prdIndex = process.argv.slice(2).indexOf("--prd");
  if (prdIndex !== -1) {
    const prdPath = process.argv.slice(2)[prdIndex + 1];
    if (!prdPath) {
      logError("--prd requires a file path");
      process.exit(1);
    }
    if (!(await fileExists(prdPath))) {
      logError(`PRD file not found: ${prdPath}`);
      process.exit(1);
    }

    const prdContent = await readText(prdPath);
    const prdTitle = prdContent.match(/^#\s+(.+)$/m)?.[1]?.trim() || "Generated from PRD";
    const { id, paths } = await createSession(cwd, prdTitle);
    await updateSessionMetadata(cwd, id, { agentName });

    // Create worktree if -w flag is set
    if (useWorktree) {
      const wtName = explicitWorktreeName ?? deriveSessionSlug(prdTitle);
      const { wtPath, branchName } = await createWorktreeForSession(repoRoot, wtName, tuiEnabled);
      process.chdir(wtPath);
      sessionCwd = wtPath;
      await updateSessionMetadata(sessionCwd, id, { branch: branchName, worktreePath: wtPath });
    }

    await writeText(paths.prd, prdContent);
    const taskPrefix = await setSessionSlugAndPrefix(cwd, id, prdTitle);
    log(fmt.info(`Created session: ${id}`));

    const [{ getAgent }, { generateTasks }] = await Promise.all([
      loadAgentRegistry(),
      loadPlanner(),
    ]);
    const agent = getAgent(config.agent.name);

    let taskFile;
    let prdRenderer: Awaited<ReturnType<Awaited<ReturnType<typeof loadTui>>["createCliRenderer"]>> | undefined;
    let prdRoot: ReturnType<Awaited<ReturnType<typeof loadTui>>["createRoot"]> | undefined;

    if (tuiEnabled) {
      const tui = await loadTui();
      prdRenderer = await tui.createCliRenderer({
        exitOnCtrlC: false,
        useKittyKeyboard: { disambiguate: true, alternateKeys: true },
      });
      prdRoot = tui.createRoot(prdRenderer);

      let streamOutput = "";
      let taskCount = 0;
      let phase = "Analyzing PRD";
      let phaseStartTime = Date.now();
      prdRoot.render(<tui.GeneratingView output={streamOutput} phase={phase} phaseStartTime={phaseStartTime} />);

      try {
        taskFile = await generateTasks(
          agent, paths.prd, config.project.name, config.project.branch, sessionCwd,
          {
            model: config.agent.model,
            taskPrefix,
            onProgress: (chunk) => {
              streamOutput += chunk;
              const ids = streamOutput.match(/\b[A-Z]{2,5}-\d{3}\b/g);
              if (ids) {
                taskCount = new Set(ids).size;
                if (phase !== "Validating dependencies" && phase !== "Generating tasks") {
                  phase = "Generating tasks";
                  phaseStartTime = Date.now();
                }
              }
              if (streamOutput.includes("```json") || streamOutput.includes('"tasks"')) {
                if (phase !== "Validating dependencies") {
                  phase = "Validating dependencies";
                  phaseStartTime = Date.now();
                }
              }
              prdRoot!.render(<tui.GeneratingView output={streamOutput} taskCount={taskCount} phase={phase} phaseStartTime={phaseStartTime} />);
            },
            onTool: showToolLogs
              ? (event) => {
                streamOutput += `\n${formatToolEvent(event)}\n`;
                prdRoot!.render(<tui.GeneratingView output={streamOutput} taskCount={taskCount} phase={phase} phaseStartTime={phaseStartTime} />);
              }
              : undefined,
          },
        );
      } catch (err) {
        prdRoot.unmount();
        prdRenderer.destroy();
        agent.dispose();
        throw err;
      }
    } else {
      log("Generating tasks from PRD...");
      let streamOutput = "";
      let lastLogTime = 0;
      taskFile = await generateTasks(agent, paths.prd, config.project.name, config.project.branch, sessionCwd, {
        model: config.agent.model,
        taskPrefix,
        onProgress: (chunk) => {
          streamOutput += chunk;
          const ids = streamOutput.match(/\b[A-Z]{2,5}-\d{3}\b/g);
          if (ids) {
            const count = new Set(ids).size;
            const now = Date.now();
            if (now - lastLogTime >= 3000) {
              lastLogTime = now;
              log(fmt.info(`Found ${count} task(s) so far...`));
            }
          }
        },
        onTool: showToolLogs
          ? (event) => {
            log(formatToolEvent(event));
          }
          : undefined,
      });
    }

    await saveTasks(paths.tasks, taskFile);
    await writeText(paths.progress, "## Codebase Patterns\n\n---\n\n");
    await updateSessionMetadata(cwd, id, {
      status: "planning",
      taskCount: taskFile.tasks.length,
    });

    // Auto-chain into execution
    agent.dispose();
    if (prdRenderer && prdRoot) {
      try {
        await cmdRun(id, 0, { renderer: prdRenderer, root: prdRoot }, buildRunContext(ctx));
      } finally {
        prdRoot.unmount();
        prdRenderer.destroy();
      }
    } else {
      await cmdRun(id, 0, undefined, buildRunContext(ctx));
    }
    return;
  }

  if (sessionIdOrFlag && sessionIdOrFlag !== "start") {
    const plan = await getSession(cwd, sessionIdOrFlag);
    if (plan) {
      // Show basic session info
      log(fmt.bold(`Session: ${plan.metadata.id}`));
      log(fmt.label("  Status:", plan.metadata.status));
      log(fmt.label("  Description:", plan.metadata.description));
      if (await fileExists(plan.paths.tasks)) {
        const taskFile = await loadTasks(plan.paths.tasks);
        const progress = getProgress(taskFile);
        log(
          fmt.bold("Tasks:") + ` ${progress.done}/${progress.total} done, ${progress.failed} failed, ${progress.open} open`,
        );
      }
      log(`\nTo resume: ${fmt.bold(`synth resume ${sessionIdOrFlag}`)}`);
      return;
    }
  }

  const [{ getAgent }, interviewMod, { generateTasks }] = await Promise.all([
    loadAgentRegistry(),
    loadInterviewer(),
    loadPlanner(),
  ]);

  const agent = getAgent(config.agent.name);

  let prdMarkdown: string | null = null;

  // Create session early so we have paths for interview state persistence
  const { id, paths } = await createSession(cwd, "");
  await updateSessionMetadata(cwd, id, { agentName });
  const logger = getLogger();

  // Create worktree if -w flag is set (use session ID as fallback name before PRD title is known)
  let worktreeBranchName: string | undefined;
  if (useWorktree) {
    const wtName = explicitWorktreeName ?? id;
    const { wtPath, branchName } = await createWorktreeForSession(repoRoot, wtName, tuiEnabled);
    process.chdir(wtPath);
    sessionCwd = wtPath;
    worktreeBranchName = branchName;
    await updateSessionMetadata(sessionCwd, id, { branch: branchName, worktreePath: wtPath });
  }
  logger.info("session:start", `Session ${id} started`, {
    sessionId: id,
    cwd: sessionCwd,
    worktreePath: useWorktree ? sessionCwd : undefined,
  });

  const interviewer = new interviewMod.Interviewer(agent, sessionCwd, config.agent.model, async (messages) => {
    const state: InterviewState = {
      messages: messages as InterviewMessage[],
      interviewerHistory: messages as InterviewMessage[],
      prdPending: !prdMarkdown,
    };
    await writeJson(paths.interview, state);
  });

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

    // Phase 1: Interview
    logger.info("interview:start", "Interview started", { sessionId: id });
    const interviewResult = await new Promise<boolean>((resolve) => {
      planRoot.render(
        <tui.InterviewApp
          sessionId={id}
          onSendMessage={async (msg, onChunk, onTool) => {
            logger.info("interview:prompt", "User message", { length: msg.length });
            try {
              const response = await interviewer.respond(msg, onChunk, showToolLogs ? onTool : undefined);
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
      return;
    }

    if (!prdMarkdown) {
      logger.warn("prd:missing", "No PRD extracted from interview");
      process.off("SIGINT", sigintHandler);
      cleanup();
      agent.dispose();
      return;
    }

    // Phase 2: PRD Review (user can revise before task generation)
    const taskPrefix = await setSessionSlugAndPrefix(cwd, id, interviewMod.extractPrdTitle(prdMarkdown));

    // Rename worktree branch to match PRD slug (if auto-generated name was used)
    if (useWorktree && !explicitWorktreeName && worktreeBranchName) {
      worktreeBranchName = await renameWorktreeBranch(worktreeBranchName, interviewMod.extractPrdTitle(prdMarkdown), id, sessionCwd);
    }

    logger.info("prd:review-start", "PRD review started", { sessionId: id });
    let approvedPrdContent: string | null = null;
    const prdApproved = await new Promise<boolean>((resolve) => {
      planRoot.render(
        <tui.PrdReviewView
          prdMarkdown={prdMarkdown!}
          agent={agent}
          cwd={sessionCwd}
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
        agent, paths.prd, config.project.name, config.project.branch || `synth/${id}`, sessionCwd,
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
    await cmdRun(id, 0, { renderer: planRenderer, root: planRoot }, buildRunContext(ctx));
    cleanup();
    return;
  } else {
    log(`\n${ansi.magenta}Synth:${ansi.reset}`);
    log(interviewMod.WELCOME_MESSAGE);
    logger.info("interview:start", "Interview started", { sessionId: id });

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
  }

  // Non-TUI path continues here (TUI path returns early above)
  if (!prdMarkdown) {
    agent.dispose();
    return;
  }

  logger.info("prd:approved", "PRD confirmed", { length: prdMarkdown.length });
  await writeText(paths.prd, prdMarkdown);
  const taskPrefix = await setSessionSlugAndPrefix(cwd, id, interviewMod.extractPrdTitle(prdMarkdown));

  // Rename worktree branch to match PRD slug (if auto-generated name was used)
  if (useWorktree && !explicitWorktreeName && worktreeBranchName) {
    worktreeBranchName = await renameWorktreeBranch(worktreeBranchName, interviewMod.extractPrdTitle(prdMarkdown), id, sessionCwd);
  }

  logSuccess(`PRD saved to ${paths.prd}`);

  log("Generating tasks...\n");
  logger.info("tasks:generate-start", "Generating tasks from PRD", { sessionId: id });
  let taskFile;
  try {
    taskFile = await generateTasks(agent, paths.prd, config.project.name, config.project.branch || `synth/${id}`, sessionCwd, {
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

  const readline = await import("node:readline");
  const rl2 = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl2.question(`\nStart executing? (Y/n) `, resolve);
  });
  rl2.close();

  agent.dispose();

  if (!answer || answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
    logger.info("run:auto-start", "Execution requested", { sessionId: id });
    await cmdRun(id, 0, undefined, buildRunContext(ctx));
  } else {
    logger.info("run:deferred", "Execution deferred", { sessionId: id });
    log(
      `\nSession saved. Resume later with: ${fmt.bold(`synth resume ${id}`)}`,
    );
  }
}

// ── Yargs CommandModule ──

const startCommand: CommandModule = {
  command: "start [session-id]",
  describe: "Start a new session — interview, generate tasks, and execute",
  builder: (yargs) =>
    yargs
      .positional("session-id", {
        type: "string",
        describe: "Optional session ID to inspect",
      })
      .option("prd", {
        type: "string",
        describe: "Path to existing PRD file",
      })
      .option("w", {
        alias: "worktree",
        type: "string",
        describe: "Run in a git worktree",
      })
      .option("agent", {
        type: "string",
        describe: "Override agent for this session (e.g. claude, codex)",
      })
      .example("synth start", "Start a new interactive session")
      .example("synth start --prd spec.md", "Start from an existing PRD")
      .example("synth start -w my-feature --prd spec.md", "Start in a worktree from PRD")
      .example("synth start --agent codex", "Start with a different agent"),
  async handler(argv) {
    const cwd = process.cwd();
    const tuiEnabled = process.stdout.isTTY === true && !process.argv.includes("--no-tui");
    const agentName = argv.agent as string | undefined;

    // Parse parallel flags from process.argv (global options, not start-specific)
    const rawArgs = process.argv.slice(2);
    const noParallelFlag = rawArgs.includes("--no-parallel");
    const parallelIndex = rawArgs.indexOf("--parallel");
    let parallelMode = false;
    let parallelWorkers: number | undefined;
    if (noParallelFlag) {
      parallelMode = false;
    } else if (parallelIndex !== -1) {
      parallelMode = true;
      const next = rawArgs[parallelIndex + 1];
      if (next && /^\d+$/.test(next)) {
        parallelWorkers = parseInt(next, 10);
      }
    }

    // Apply parallel default from config if no explicit flag
    if (!noParallelFlag && parallelIndex === -1) {
      const { loadConfig } = await import("../config/loader.js");
      const cfg = await loadConfig(cwd);
      parallelMode = cfg.parallel?.enabled ?? true;
    }

    await cmdStart(argv["session-id"] as string | undefined, {
      cwd,
      tuiEnabled,
      parallelMode,
      parallelWorkers,
      agentName,
    });
  },
};

export default startCommand;
