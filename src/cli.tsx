#!/usr/bin/env bun

import { join } from "node:path";
import { loadConfig } from "./config/loader.js";
import type { SynthConfig } from "./config/types.js";
import { globalConfigPath } from "./config/paths.js";
import { PERSONAL_CONFIG_TEMPLATE } from "./config/defaults.js";
import {
  createSession,
  getSession,
  listSessions,
  listAllSessions,
  getMostRecentSession,
  updateSessionMetadata,
  deleteSession,
} from "./sessions/registry.js";
import { deriveSessionSlug, deriveTaskPrefix } from "./sessions/slug.js";
import { loadTasks, saveTasks, getProgress, resetOrphanedTasks, allTasksDone } from "./tasks/store.js";
import { writeText, readText, readJson, fileExists, writeJson, removeFile } from "./utils/fs.js";
import { spawn } from "./utils/process.js";
import { ansi, fmt, STATUS_ICONS, STATUS_COLORS, PRIORITY_COLORS } from "./tui/theme.js";
import { globalTrace, formatProfileReport, formatProfileReportJson } from "./utils/perf.js";

import { listBuiltinThemes, discoverCustomThemes } from "./tui/themes/registry.js";
import { listSpinnerPresets } from "./tui/spinners.js";
import { createSpinner, withSpinner } from "./tui/spinner.js";
import type { TuiContext } from "./tui/types.js";

import { cmdRun as cmdRunExtracted } from "./commands/run.js";
import {
  VERSION,
  REPO,
  log,
  logError,
  logSuccess,
  applyTheme as applyThemeWithCwd,
  loadAgentRegistry,
  loadEngine,
  loadRunModule,
  loadReviewOrchestrator,
  loadParallelCoordinator,
  loadTui,
  loadFinalize,
  loadInterviewer,
  loadPlanner,
} from "./commands/helpers.js";

const cwd = process.cwd();
const args = process.argv.slice(2);
const command = args[0];

const tuiEnabled = process.stdout.isTTY === true && !args.includes("--no-tui");

/**
 * Derive slug + prefix from a PRD title, update session metadata, and return the task prefix.
 */
async function setSessionSlugAndPrefix(sessionId: string, title: string): Promise<string> {
  const slug = deriveSessionSlug(title);
  await updateSessionMetadata(cwd, sessionId, { description: title, slug });
  return deriveTaskPrefix(title);
}
const profileEnabled = args.includes("--profile");
const profileJson = args.includes("--profile-json");

if (profileEnabled || profileJson) {
  globalTrace().enabled = true;
}

// Parse --parallel [N] / --no-parallel flags
// Priority: --no-parallel (force serial) > --parallel (force parallel) > config.parallel.enabled
const parallelIndex = args.indexOf("--parallel");
const noParallelFlag = args.includes("--no-parallel");
let parallelMode = false;
let parallelWorkers: number | undefined;
if (noParallelFlag) {
  parallelMode = false;
} else if (parallelIndex !== -1) {
  parallelMode = true;
  const next = args[parallelIndex + 1];
  if (next && /^\d+$/.test(next)) {
    parallelWorkers = parseInt(next, 10);
  }
}

function applyParallelDefault(config: SynthConfig): void {
  if (!noParallelFlag && parallelIndex === -1) {
    parallelMode = config.parallel?.enabled ?? true;
  }
}

async function applyTheme(): Promise<SynthConfig> {
  return applyThemeWithCwd(cwd);
}

async function cmdInit(): Promise<void> {
  const configPath = join(cwd, "synth.toml");
  if (await fileExists(configPath)) {
    log(fmt.warn("synth.toml already exists"));
    return;
  }

  const examplePath = join(import.meta.dir, "..", "synth.toml.example");
  let template: string;
  if (await fileExists(examplePath)) {
    template = await readText(examplePath);
  } else {
    const name = cwd.split("/").pop() ?? "my-project";
    template = `# Project config — personal prefs go in: synth config --global --edit

[project]
name = "${name}"
branch = "feature/synth"

[execution]
max_iterations = 20
iteration_delay = 2000
auto_commit = true

[guardrails]
max_consecutive_failures = 3
backpressure_commands = []

[finalize]
auto_format = true
split_commits = true
self_review = true
create_pr = true
`;
  }

  await writeText(configPath, template);
  logSuccess("Created synth.toml");
}

async function resolvePlanId(input?: string): Promise<string | undefined> {
  if (!input) return undefined;
  if (/^\d+$/.test(input)) {
    const allPlans = await listSessions(cwd);
    const plans = allPlans.filter((p) => p.status !== "completed" && p.status !== "finalized");
    const idx = parseInt(input, 10) - 1;
    if (idx < 0 || idx >= plans.length) {
      // Check if the index refers to a completed/finalized session
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

async function cmdLs(): Promise<void> {
  const showAll = args.includes("--all") || args.includes("-a");
  const globalMode = args.includes("--global") || args.includes("-g");
  const allPlans = globalMode ? await listAllSessions() : await listSessions(cwd);
  const plans = showAll
    ? allPlans
    : allPlans.filter((p) => p.status !== "completed" && p.status !== "finalized");

  if (plans.length === 0) {
    if (allPlans.length > 0) {
      log(fmt.dim(`All ${allPlans.length} session(s) are completed. Use 'synth ls --all' to show them.`));
    } else {
      log(fmt.dim("No sessions found. Run 'synth start' to create one."));
    }
    return;
  }

  const label = showAll
    ? globalMode ? "Sessions (all repos, all)" : "Sessions (all)"
    : globalMode ? "Sessions (all repos)" : "Sessions";
  const hidden = allPlans.length - plans.length;
  const suffix = hidden > 0 ? ` ${ansi.muted}(${hidden} completed hidden, use --all)${ansi.reset}` : "";
  log(`${fmt.bold(label)}${suffix}\n`);

  if (globalMode) {
    log(
      `  ${ansi.muted}${"#".padEnd(4)} ${"ID".padEnd(25)} ${"Repo".padEnd(22)} ${"Status".padEnd(12)} ${"Tasks".padEnd(10)} Created${ansi.reset}`,
    );
    log(`  ${ansi.muted}${"─".repeat(96)}${ansi.reset}`);
  } else {
    log(
      `  ${ansi.muted}${"#".padEnd(4)} ${"ID".padEnd(25)} ${"Status".padEnd(12)} ${"Tasks".padEnd(10)} Created${ansi.reset}`,
    );
    log(`  ${ansi.muted}${"─".repeat(74)}${ansi.reset}`);
  }

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const statusColor =
      plan.status === "completed" || plan.status === "finalized"
        ? ansi.success
        : plan.status === "executing"
          ? ansi.primary
          : plan.status === "failed" || plan.status === "blocked"
            ? ansi.error
            : ansi.muted;
    const icon = STATUS_ICONS[plan.status] ?? "○";
    const date = fmt.dim(new Date(plan.createdAt).toLocaleDateString());
    const repoCol = globalMode ? `${fmt.dim(plan.repoKey.padEnd(22))} ` : "";
    log(
      `  ${ansi.primary}${String(i + 1).padEnd(4)}${ansi.reset}${plan.id.padEnd(25)} ${repoCol}${statusColor}${icon} ${plan.status.padEnd(10)}${ansi.reset} ${`${plan.tasksCompleted}/${plan.taskCount}`.padEnd(10)} ${date}`,
    );
  }
}

async function cmdShow(sessionId: string): Promise<void> {
  const plan = await getSession(cwd, sessionId);
  if (!plan) {
    logError(`Session '${sessionId}' not found`);
    process.exit(1);
  }

  log(fmt.bold(`Session: ${plan.metadata.id}`));
  log(fmt.label("  Status:", plan.metadata.status));
  log(fmt.label("  Created:", plan.metadata.createdAt));
  log(fmt.label("  Updated:", plan.metadata.updatedAt));
  log(fmt.label("  Description:", plan.metadata.description));
  log("");

  if (await fileExists(plan.paths.tasks)) {
    const taskFile = await loadTasks(plan.paths.tasks);
    const progress = getProgress(taskFile);
    log(
      fmt.bold("Tasks:") + ` ${progress.done}/${progress.total} done, ${progress.failed} failed, ${progress.open} open`,
    );
    log("");
    for (const task of taskFile.tasks) {
      const icon = STATUS_ICONS[task.status] ?? "?";
      const color = STATUS_COLORS[task.status] ?? ansi.muted;
      log(`  ${color}${icon}${ansi.reset} ${task.id} ${task.title}`);
    }
  }

  if (await fileExists(plan.paths.prd)) {
    log(`\n${fmt.label("PRD:", plan.paths.prd)}`);
  }
}

async function cmdStatus(sessionId?: string): Promise<void> {
  let plan;
  if (sessionId) {
    plan = await getSession(cwd, sessionId);
  } else {
    plan = await getMostRecentSession(cwd);
  }

  if (!plan) {
    log(fmt.dim("No active session. Run 'synth start' to create one."));
    return;
  }

  log(`${fmt.bold(plan.metadata.id)} ${ansi.muted}─${ansi.reset} ${plan.metadata.status}`);

  if (await fileExists(plan.paths.tasks)) {
    const taskFile = await loadTasks(plan.paths.tasks);
    const progress = getProgress(taskFile);
    const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
    const barWidth = 20;
    const filled = Math.floor(pct / (100 / barWidth));
    const bar = `${ansi.success}${"▓".repeat(filled)}${ansi.muted}${"░".repeat(barWidth - filled)}${ansi.reset}`;
    log(`Progress: [${bar}] ${ansi.bold}${pct}%${ansi.reset} (${progress.done}/${progress.total})`);
  }

  const { loadRun } = await loadRunModule();
  const run = await loadRun(plan.paths);
  if (run) {
    log(fmt.label("Session:", `${run.status} (iteration ${run.currentIteration})`));
  }
}

async function cmdConfig(): Promise<void> {
  const isGlobal = args.includes("--global");
  const isEdit = args.includes("--edit");

  if (isGlobal) {
    const gp = globalConfigPath();
    if (isEdit) {
      if (!(await fileExists(gp))) {
        await writeText(gp, PERSONAL_CONFIG_TEMPLATE);
        logSuccess(`Created ${gp}`);
      }
      const editor = process.env.EDITOR || process.env.VISUAL || "vi";
      const parts = editor.split(/\s+/);
      const proc = Bun.spawn([...parts, gp], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      await proc.exited;
      try {
        await loadConfig(cwd);
        logSuccess("Config valid");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Config error: ${message}`);
      }
    } else {
      if (!(await fileExists(gp))) {
        log(fmt.info(`No personal config found at ${gp}`));
        log(fmt.muted(`Create one with: synth config --global --edit`));
        return;
      }
      const raw = await readText(gp);
      log(raw);
    }
    return;
  }

  if (isEdit) {
    const configPath = join(cwd, "synth.toml");
    if (!(await fileExists(configPath))) {
      log(fmt.info("No synth.toml found, creating one..."));
      await cmdInit();
    }
    const editor = process.env.EDITOR || process.env.VISUAL || "vi";
    const parts = editor.split(/\s+/);
    const proc = Bun.spawn([...parts, configPath], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    await proc.exited;

    try {
      await loadConfig(cwd);
      logSuccess("Config valid");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Config error: ${message}`);
    }
    return;
  }

  const config = await applyTheme();
  const json = JSON.stringify(config, null, 2);
  const colorized = json
    .replace(/"([^"]+)":/g, `${ansi.primary}"$1"${ansi.reset}:`)
    .replace(/: "([^"]+)"/g, `: ${ansi.success}"$1"${ansi.reset}`)
    .replace(/: (\d+)/g, `: ${ansi.warning}$1${ansi.reset}`)
    .replace(/: (true|false)/g, `: ${ansi.magenta}$1${ansi.reset}`);
  log(colorized);
}

async function cmdDoctor(): Promise<void> {
  const { runDoctorChecks } = await import("./doctor/doctor.js");
  let config;
  try {
    config = await loadConfig(cwd);
  } catch {
    // Config may be invalid — doctor will report it
  }

  log(`${ansi.bold}synth doctor${ansi.reset}\n`);
  const results = await runDoctorChecks(cwd, config);
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;

  for (const r of results) {
    if (r.status === "pass") {
      log(`  ${ansi.success}✓${ansi.reset} ${r.name}${r.message ? ` ${ansi.muted}(${r.message})${ansi.reset}` : ""}`);
    } else if (r.status === "fail") {
      log(`  ${ansi.error}✗${ansi.reset} ${r.name}: ${r.message ?? "failed"}`);
      if (r.suggestion) log(`    ${ansi.muted}→ ${r.suggestion}${ansi.reset}`);
    } else {
      log(`  ${ansi.warning}⚠${ansi.reset} ${r.name}: ${r.message ?? "warning"}`);
      if (r.suggestion) log(`    ${ansi.muted}→ ${r.suggestion}${ansi.reset}`);
    }
  }

  const summaryColor = failed > 0 ? ansi.error : ansi.success;
  log(`\n${summaryColor}${passed}/${results.length} checks passed${ansi.reset}`);

  if (failed > 0) process.exit(1);
}

async function cmdThemes(): Promise<void> {
  const config = await applyTheme();
  const activeTheme = config.tui?.theme ?? "tokyonight";
  const activeSpinner = config.tui?.spinner ?? "braille";

  // Built-in themes
  const builtins = listBuiltinThemes();
  log(fmt.bold("Built-in Themes:"));
  for (const { name } of builtins) {
    const marker = name === activeTheme ? ` ${ansi.success}● active${ansi.reset}` : "";
    log(`  ${ansi.primary}${name}${ansi.reset}${marker}`);
  }

  // Custom themes
  const custom = await discoverCustomThemes();
  if (custom.length > 0) {
    log(`\n${fmt.bold("Custom Themes:")} ${ansi.muted}(~/.config/synth/themes/)${ansi.reset}`);
    for (const name of custom) {
      const marker = name === activeTheme ? ` ${ansi.success}● active${ansi.reset}` : "";
      log(`  ${ansi.primary}${name}${ansi.reset}${marker}`);
    }
  } else {
    log(`\n${fmt.dim("No custom themes found in ~/.config/synth/themes/")}`);
  }

  // Spinner presets
  const spinners = listSpinnerPresets();
  log(`\n${fmt.bold("Spinner Presets:")}`);
  for (const name of spinners) {
    const marker = name === activeSpinner ? ` ${ansi.success}● active${ansi.reset}` : "";
    log(`  ${ansi.primary}${name}${ansi.reset}${marker}`);
  }
}

async function cmdRun(sessionId?: string, startIteration = 0, tuiContext?: TuiContext): Promise<void> {
  applyParallelDefault(await applyTheme());
  return cmdRunExtracted(sessionId, startIteration, tuiContext, {
    cwd,
    tuiEnabled,
    parallelMode,
    parallelWorkers,
    cmdFinalize,
  });
}


async function cmdResume(sessionId?: string): Promise<void> {
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
      const savedState: import("./interview/types.js").InterviewState = (await fileExists(plan.paths.interview))
        ? await readJson<import("./interview/types.js").InterviewState>(plan.paths.interview)
        : { messages: [], interviewerHistory: [], prdPending: true };
      if (savedState.prdPending) {
        const msgCount = savedState.interviewerHistory.length;
        log(fmt.info(msgCount > 0
          ? `Resuming interview for session ${id} (${msgCount} messages saved)`
          : `Starting fresh interview for session ${id}`));
        await resumeInterview(plan, savedState);
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
      const savedConversation = await readJson<import("./finalize/chat-types.js").FinalizeMessage[]>(finalizePath);
      const statePath = join(plan.paths.root, "finalize-state.json");
      const savedState = (await fileExists(statePath))
        ? await readJson<import("./finalize/chat-types.js").OrchestratorState>(statePath)
        : undefined;
      log(fmt.info(`Resuming finalize review for session ${id} (${savedConversation.length} messages)`));
      await cmdFinalize(id, undefined, undefined, savedConversation, savedState);
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
        await cmdFinalize(id);
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
      const config = await applyTheme();
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

          const reviewPaths: import("./sessions/types.js").SessionPaths = {
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
      await cmdFinalize(id);
    }
    return;
  }

  log(fmt.info(`Resuming session ${id} (iteration ${run.currentIteration})`));
  await cmdRun(id, run.currentIteration);
}

async function resumeInterview(
  plan: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  savedState: import("./interview/types.js").InterviewState,
): Promise<void> {
  const config = await applyTheme();

  const [{ getAgent }, interviewMod, { generateTasks }] = await Promise.all([
    loadAgentRegistry(),
    loadInterviewer(),
    loadPlanner(),
  ]);

  const agent = getAgent(config.agent.name);

  let prdMarkdown: string | null = null;
  const { id, paths } = { id: plan.metadata.id, paths: plan.paths };

  const interviewer = new interviewMod.Interviewer(agent, cwd, config.agent.model, async (messages) => {
    const state: import("./interview/types.js").InterviewState = {
      messages: messages as import("./interview/types.js").InterviewMessage[],
      interviewerHistory: messages as import("./interview/types.js").InterviewMessage[],
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
    const taskPrefix = await setSessionSlugAndPrefix(id, interviewMod.extractPrdTitle(prdMarkdown));

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
        agent, paths.prd, config.project.name, config.project.branch || `synth/${id}`, sessionCwd,
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
    await cmdRun(id, 0, { renderer: planRenderer, root: planRoot });
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
    const taskPrefix = await setSessionSlugAndPrefix(id, interviewMod.extractPrdTitle(prdMarkdown));

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
      await cmdRun(id);
    } else {
      log(`\nSession saved. Resume later with: ${fmt.bold(`synth resume ${id}`)}`);
    }
  }
}

export function parseWorktreeFlag(argv: string[]): { useWorktree: boolean; explicitName?: string } {
  const wIndex = argv.indexOf("-w") !== -1 ? argv.indexOf("-w") : argv.indexOf("--worktree");
  if (wIndex === -1) return { useWorktree: false };
  const next = argv[wIndex + 1];
  if (next && !next.startsWith("-")) {
    return { useWorktree: true, explicitName: next };
  }
  return { useWorktree: true };
}

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

async function cmdStart(sessionIdOrFlag?: string): Promise<void> {
  const config = await applyTheme();
  const repoRoot = cwd;
  let sessionCwd = cwd;

  const { useWorktree, explicitName: explicitWorktreeName } = parseWorktreeFlag(args);

  const prdIndex = args.indexOf("--prd");
  if (prdIndex !== -1) {
    const prdPath = args[prdIndex + 1];
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

    // Create worktree if -w flag is set
    if (useWorktree) {
      const wtName = explicitWorktreeName ?? deriveSessionSlug(prdTitle);
      const { wtPath, branchName } = await createWorktreeForSession(repoRoot, wtName);
      process.chdir(wtPath);
      sessionCwd = wtPath;
      await updateSessionMetadata(sessionCwd, id, { branch: branchName, worktreePath: wtPath });
    }

    await writeText(paths.prd, prdContent);
    const taskPrefix = await setSessionSlugAndPrefix(id, prdTitle);
    log(fmt.info(`Created session: ${id}`));

    const [{ getAgent }, { generateTasks }] = await Promise.all([
      loadAgentRegistry(),
      loadPlanner(),
    ]);
    const agent = getAgent(config.agent.name);

    const taskFile = tuiEnabled
      ? await withSpinner("Generating tasks from PRD", () =>
          generateTasks(agent, paths.prd, config.project.name, config.project.branch, sessionCwd, { model: config.agent.model, taskPrefix }),
          { successMessage: fmt.success("Tasks generated") },
        )
      : await (async () => {
          log("Generating tasks from PRD...");
          return generateTasks(agent, paths.prd, config.project.name, config.project.branch, sessionCwd, { model: config.agent.model, taskPrefix });
        })();

    await saveTasks(paths.tasks, taskFile);
    await writeText(paths.progress, "## Codebase Patterns\n\n---\n\n");
    await updateSessionMetadata(cwd, id, {
      status: "planning",
      taskCount: taskFile.tasks.length,
    });

    // Auto-chain into execution
    agent.dispose();
    await cmdRun(id);
    return;
  }

  if (sessionIdOrFlag && sessionIdOrFlag !== "start") {
    const plan = await getSession(cwd, sessionIdOrFlag);
    if (plan) {
      await cmdShow(sessionIdOrFlag);
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

  // Create worktree if -w flag is set (use session ID as fallback name before PRD title is known)
  let worktreeBranchName: string | undefined;
  if (useWorktree) {
    const wtName = explicitWorktreeName ?? id;
    const { wtPath, branchName } = await createWorktreeForSession(repoRoot, wtName);
    process.chdir(wtPath);
    sessionCwd = wtPath;
    worktreeBranchName = branchName;
    await updateSessionMetadata(sessionCwd, id, { branch: branchName, worktreePath: wtPath });
  }

  const interviewer = new interviewMod.Interviewer(agent, sessionCwd, config.agent.model, async (messages) => {
    const state: import("./interview/types.js").InterviewState = {
      messages: messages as import("./interview/types.js").InterviewMessage[],
      interviewerHistory: messages as import("./interview/types.js").InterviewMessage[],
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
    const interviewResult = await new Promise<boolean>((resolve) => {
      planRoot.render(
        <tui.InterviewApp
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

    // Phase 2: PRD Review (user can revise before task generation)
    const taskPrefix = await setSessionSlugAndPrefix(id, interviewMod.extractPrdTitle(prdMarkdown));

    // Rename worktree branch to match PRD slug (if auto-generated name was used)
    if (useWorktree && !explicitWorktreeName && worktreeBranchName) {
      worktreeBranchName = await renameWorktreeBranch(worktreeBranchName, interviewMod.extractPrdTitle(prdMarkdown), id, sessionCwd);
    }

    let approvedPrdContent: string | null = null;
    const prdApproved = await new Promise<boolean>((resolve) => {
      planRoot.render(
        <tui.PrdReviewView
          prdMarkdown={prdMarkdown!}
          agent={agent}
          cwd={sessionCwd}
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
        agent, paths.prd, config.project.name, config.project.branch || `synth/${id}`, sessionCwd,
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
    await cmdRun(id, 0, { renderer: planRenderer, root: planRoot });
    cleanup();
    return;
  } else {
    log(`\n${ansi.magenta}Synth:${ansi.reset}`);
    log(interviewMod.WELCOME_MESSAGE);

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
  }

  // Non-TUI path continues here (TUI path returns early above)
  if (!prdMarkdown) {
    agent.dispose();
    return;
  }

  await writeText(paths.prd, prdMarkdown);
  const taskPrefix = await setSessionSlugAndPrefix(id, interviewMod.extractPrdTitle(prdMarkdown));

  // Rename worktree branch to match PRD slug (if auto-generated name was used)
  if (useWorktree && !explicitWorktreeName && worktreeBranchName) {
    worktreeBranchName = await renameWorktreeBranch(worktreeBranchName, interviewMod.extractPrdTitle(prdMarkdown), id, sessionCwd);
  }

  logSuccess(`PRD saved to ${paths.prd}`);

  log("Generating tasks...\n");
  const taskFile = await generateTasks(agent, paths.prd, config.project.name, config.project.branch || `synth/${id}`, sessionCwd, { model: config.agent.model, taskPrefix });

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
    await cmdRun(id);
  } else {
    log(
      `\nSession saved. Resume later with: ${fmt.bold(`synth resume ${id}`)}`,
    );
  }
}

interface FinalizeRunContext {
  config: SynthConfig;
  sessionPaths: import("./sessions/types.js").SessionPaths;
}

async function cmdFinalize(
  sessionId?: string,
  tuiContext?: TuiContext,
  runContext?: FinalizeRunContext,
  savedConversation?: import("./finalize/chat-types.js").FinalizeMessage[],
  savedState?: import("./finalize/chat-types.js").OrchestratorState,
): Promise<void> {
  const config = runContext?.config ?? await applyTheme();

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
      import("./finalize/orchestrator.js"),
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
          const { fixTasksToTasks } = await import("./finalize/fix-converter.js");
          const { buildFixTuiData } = await import("./finalize/parallel-bridge.js");

          const fixes = orchestrator.getConfirmedFixes();
          const tasks = fixTasksToTasks(fixes, cwd);
          const { analyzeTaskGraph } = await loadParallelCoordinator();
          const analysis = analyzeTaskGraph(tasks);
          const useParallel = tasks.length >= 3 && analysis.recommendParallel;

          if (useParallel) {
            // ── Parallel execution TUI ──
            const { createInitialTuiState, applyParallelEvent, attachParallelLogger } = await import("./finalize/parallel-bridge.js");
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

            const { ParallelBridge } = await import("./tui/ParallelBridge.js");
            const tuiData = buildFixTuiData(tasks, config, plan!.metadata.id, "Parallel fix execution");
            const parallelState = createInitialTuiState(tasks.length);
            let parallelDestroyed = false;

            // Render ONCE — the bridge manages its own re-renders via _notify
            root!.render(
              <ParallelBridge
                tuiData={tuiData}
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
            const { SerialBridge } = await import("./tui/ParallelBridge.js");
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

async function cmdPs(): Promise<void> {
  const plans = await listSessions(cwd);
  const running = plans.filter((p) =>
    p.status === "executing" || p.status === "reviewing" || p.status === "finalizing"
  );

  if (running.length === 0) {
    log(fmt.dim("No running synth instances."));
    return;
  }

  log(fmt.bold("Running instances:") + "\n");
  for (const plan of running) {
    log(`  ${ansi.success}●${ansi.reset} ${plan.id} ${ansi.muted}─${ansi.reset} ${plan.description}`);
  }
}

const TERMINAL_STATUSES = new Set(["completed", "finalized", "failed"]);
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function cmdRm(): Promise<void> {
  const staleFlag = args.includes("--stale");
  const ids = args.slice(1).filter((a) => !a.startsWith("-"));

  if (!staleFlag && ids.length === 0) {
    log(`Usage: synth rm <id> [<id>...]`);
    log(`       synth rm --stale`);
    return;
  }

  if (staleFlag) {
    const sessions = await listSessions(cwd);
    const now = Date.now();
    const stale = sessions.filter(
      (s) => !TERMINAL_STATUSES.has(s.status) && now - new Date(s.updatedAt).getTime() > STALE_THRESHOLD_MS,
    );

    if (stale.length === 0) {
      log(fmt.dim("No stale sessions found."));
      return;
    }

    log(fmt.bold(`Removing ${stale.length} stale session(s):\n`));
    for (const s of stale) {
      const date = fmt.dim(new Date(s.updatedAt).toLocaleDateString());
      const deleted = await deleteSession(cwd, s.id);
      if (deleted) {
        logSuccess(`${s.id} ${ansi.muted}(${s.status}, last updated ${date})${ansi.reset}`);
      } else {
        logError(`${s.id} — not found on disk`);
      }
    }
    return;
  }

  for (const id of ids) {
    const resolved = await resolvePlanId(id);
    if (!resolved) continue;
    const deleted = await deleteSession(cwd, resolved);
    if (deleted) {
      logSuccess(`Removed ${resolved}`);
    } else {
      logError(`Session '${resolved}' not found`);
    }
  }
}

async function cmdClean(): Promise<void> {
  // clean is an alias for `rm --stale` — inject the flag
  if (!args.includes("--stale")) args.push("--stale");
  await cmdRm();
}

function detectPlatform(): { os: string; arch: string } {
  const platform = process.platform;
  const arch = process.arch;
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "";
  const mappedArch = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : "";
  if (!os || !mappedArch) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }
  return { os, arch: mappedArch };
}

function formatBytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function downloadAndInstall(
  tag: string,
  onProgress?: (received: number, total: number | null) => void,
): Promise<void> {
  const { os, arch } = detectPlatform();
  const binary = `synth-${os}-${arch}.gz`;
  const url = `https://github.com/${REPO}/releases/download/${tag}/${binary}`;

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status}) — check that a release exists for ${os}-${arch}`);
  }

  const contentLength = res.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : null;
  let received = 0;

  const chunks: Uint8Array[] = [];
  for await (const chunk of res.body) {
    chunks.push(chunk);
    received += chunk.length;
    onProgress?.(received, total);
  }

  const compressed = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, offset);
    offset += chunk.length;
  }

  const decompressed = Bun.gunzipSync(compressed);

  const installDir = process.env.SYNTH_INSTALL_DIR || `${process.env.HOME}/.local/bin`;
  const installPath = `${installDir}/synth`;

  const { mkdirSync, writeFileSync, chmodSync, renameSync } = await import("node:fs");
  mkdirSync(installDir, { recursive: true });
  const tmpPath = `${installPath}.tmp`;
  writeFileSync(tmpPath, decompressed);
  chmodSync(tmpPath, 0o755);
  renameSync(tmpPath, installPath);
}

async function cmdUpdate(): Promise<void> {
  let release: { tag_name: string };

  if (tuiEnabled) {
    const spinner = createSpinner("Checking for updates");
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) {
      spinner.stop(fmt.error("Failed to check for updates"));
      process.exit(1);
    }
    release = (await res.json()) as { tag_name: string };
    const latest = release.tag_name.replace(/^v/, "");

    if (latest === VERSION) {
      spinner.stop(fmt.success(`Already on latest version (${VERSION})`));
      return;
    }

    spinner.stop(fmt.info(`New version available: ${VERSION} → ${latest}`));

    const updateSpinner = createSpinner("Downloading update...");
    try {
      await downloadAndInstall(release.tag_name, (received, total) => {
        if (total) {
          const pct = Math.round((received / total) * 100);
          updateSpinner.update(`Downloading update... ${formatBytes(received)} / ${formatBytes(total)} MB (${pct}%)`);
        } else {
          updateSpinner.update(`Downloading update... ${formatBytes(received)} MB`);
        }
      });
      updateSpinner.stop(fmt.success(`Updated to v${latest}`));
    } catch (err) {
      updateSpinner.stop(fmt.error(`Update failed: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  } else {
    log("Checking for updates...");
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) {
      logError("Failed to check for updates");
      process.exit(1);
    }
    release = (await res.json()) as { tag_name: string };
    const latest = release.tag_name.replace(/^v/, "");

    if (latest === VERSION) {
      log(`Already on latest version (${VERSION})`);
      return;
    }

    log(`New version available: ${VERSION} → ${latest}`);
    log("Downloading...");

    try {
      await downloadAndInstall(release.tag_name, (received, total) => {
        if (total) {
          const pct = Math.round((received / total) * 100);
          process.stdout.write(`\r  ${formatBytes(received)} / ${formatBytes(total)} MB (${pct}%)`);
        }
      });
      process.stdout.write("\n");
      logSuccess(`Updated to v${latest}`);
    } catch (err) {
      process.stdout.write("\n");
      logError(`Update failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }
}

// Re-export for backward compatibility (used by tests)
export { buildSummaryMarkdown } from "./commands/helpers.js";

async function main(): Promise<void> {
  switch (command) {
    case "init":
      await cmdInit();
      break;
    case "start":
      await cmdStart(await resolvePlanId(args[1]));
      break;
    case "resume":
      await cmdResume(await resolvePlanId(args[1]));
      break;
    case "ls":
      await cmdLs();
      break;
    case "show": {
      const showId = await resolvePlanId(args[1]);
      if (!showId) {
        logError("Usage: synth show <session-id>");
        process.exit(1);
      }
      await cmdShow(showId);
      break;
    }
    case "status":
      await cmdStatus(await resolvePlanId(args[1]));
      break;
    case "config":
      await cmdConfig();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "themes":
      await cmdThemes();
      break;
    case "ps":
      await cmdPs();
      break;
    case "rm":
      await cmdRm();
      break;
    case "clean":
      await cmdClean();
      break;
    case "update":
      await cmdUpdate();
      break;
    case "version":
    case "--version":
    case "-v":
      log(`${ansi.bold}synth${ansi.reset} ${ansi.muted}v${VERSION}${ansi.reset}`);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined: {
      log(`${ansi.bold}synth${ansi.reset} ${ansi.muted}v${VERSION}${ansi.reset} — AI Agent Loop Orchestrator\n`);
      log("Usage: synth <command> [options]\n");

      log(`${ansi.bold}Workflow:${ansi.reset}`);
      log(`  ${ansi.primary}start${ansi.reset} ${ansi.muted}[--prd <path>] [-w [name]]${ansi.reset}   Interview → tasks → execute → PR`);
      log(`  ${ansi.primary}resume${ansi.reset} ${ansi.muted}[<session-id>]${ansi.reset}             Resume a paused or interrupted session`);

      log(`\n${ansi.bold}Inspect:${ansi.reset}`);
      log(`  ${ansi.primary}ls${ansi.reset} ${ansi.muted}[--all] [--global]${ansi.reset}     List sessions (hides completed; --global for all repos)`);
      log(`  ${ansi.primary}show${ansi.reset} ${ansi.muted}<session-id>${ansi.reset}       Show session details`);
      log(`  ${ansi.primary}status${ansi.reset} ${ansi.muted}[<session-id>]${ansi.reset}   Session status`);
      log(`  ${ansi.primary}ps${ansi.reset}                       List running instances`);
      log(`  ${ansi.primary}config${ansi.reset} ${ansi.muted}[--edit] [--global]${ansi.reset}  Display or edit configuration`);
      log(`  ${ansi.primary}doctor${ansi.reset}                   Validate environment setup`);
      log(`  ${ansi.primary}themes${ansi.reset}                   List themes and spinners`);

      log(`\n${ansi.bold}System:${ansi.reset}`);
      log(`  ${ansi.primary}init${ansi.reset}                     Create synth.toml`);
      log(`  ${ansi.primary}rm${ansi.reset} ${ansi.muted}<id>... | --stale${ansi.reset}     Remove sessions (or stale sessions >7 days)`);
      log(`  ${ansi.primary}clean${ansi.reset}                    Alias for 'rm --stale'`);
      log(`  ${ansi.primary}update${ansi.reset}                   Update to latest version`);
      log(`  ${ansi.primary}version${ansi.reset}                  Show version`);

      log(`\n${ansi.bold}Options:${ansi.reset}`);
      log(`  ${ansi.muted}--parallel${ansi.reset} ${ansi.muted}[N]${ansi.reset}           Force parallel execution (default: 8 workers)`);
      log(`  ${ansi.muted}--no-parallel${ansi.reset}             Force serial execution`);
      log(`  ${ansi.muted}--no-tui${ansi.reset}                 Disable TUI (plain text output)`);
      log(`  ${ansi.muted}--profile${ansi.reset}                Print timing report to stderr on exit`);
      log(`  ${ansi.muted}--profile-json${ansi.reset}           Print timing report as JSON to stderr`);
      break;
    }
    default:
      logError(`Unknown command: ${command}`);
      log(`Run '${ansi.primary}synth help${ansi.reset}' for usage.`);
      process.exit(1);
  }
}

function printProfileReport(): void {
  const trace = globalTrace();
  if (!trace.enabled) return;
  const report = trace.report();
  if (report.phases.length === 0) return;

  if (profileJson) {
    process.stderr.write(formatProfileReportJson(report) + "\n");
  } else {
    process.stderr.write(formatProfileReport(report) + "\n");
  }
}

main()
  .then(() => {
    printProfileReport();
  })
  .catch((err) => {
    printProfileReport();
    logError(String(err));
    process.exit(1);
  });
