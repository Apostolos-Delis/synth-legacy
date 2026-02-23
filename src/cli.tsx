#!/usr/bin/env bun

import { join } from "node:path";
import { loadConfig } from "./config/loader.js";
import type { SynthConfig } from "./config/types.js";
import {
  createSession,
  getSession,
  listSessions,
  getMostRecentSession,
  updateSessionMetadata,
  deleteSession,
} from "./sessions/registry.js";
import { deriveSessionSlug, deriveTaskPrefix } from "./sessions/slug.js";
import { loadTasks, saveTasks, getProgress, resetOrphanedTasks } from "./tasks/store.js";
import { writeText, readText, readJson, fileExists, writeJson } from "./utils/fs.js";
import { spawn } from "./utils/process.js";
import { loadTaskOutput, buildIterationMap } from "./engine/output-index.js";
import { ansi, fmt, STATUS_ICONS, STATUS_COLORS, PRIORITY_COLORS, initTheme } from "./tui/theme.js";
import { globalTrace, formatProfileReport, formatProfileReportJson } from "./utils/perf.js";

import { resolveTheme } from "./tui/themes/resolve.js";
import { listBuiltinThemes, discoverCustomThemes } from "./tui/themes/registry.js";
import { listSpinnerPresets } from "./tui/spinners.js";
import { createSpinner, withSpinner } from "./tui/spinner.js";
import { stripAnsi } from "./tui/utils.js";
import type { TuiEngineData, TuiContext, CompletionSummary } from "./tui/types.js";
import { formatDuration } from "./utils/format.js";

// Heavy modules are lazy-loaded on first use to keep startup fast.
// Follows the same pattern as loadTui() below.
async function loadAgentRegistry() {
  const { getAgent } = await import("./agents/registry.js");
  return { getAgent };
}

async function loadEngine() {
  const { Engine } = await import("./engine/engine.js");
  return { Engine };
}

async function loadRunModule() {
  const mod = await import("./run/run.js");
  return {
    createRun: mod.createRun,
    loadRun: mod.loadRun,
    acquireLock: mod.acquireLock,
    releaseLock: mod.releaseLock,
    endRun: mod.endRun,
  };
}

async function loadInterviewer() {
  const { Interviewer, prdToMarkdown, WELCOME_MESSAGE } = await import("./interview/interviewer.js");
  return { Interviewer, prdToMarkdown, WELCOME_MESSAGE };
}

async function loadPlanner() {
  const { generateTasks } = await import("./tasks/planner.js");
  return { generateTasks };
}

async function loadFinalize() {
  const { finalize } = await import("./finalize/finalize.js");
  return { finalize };
}

// TUI imports are loaded dynamically to keep non-TUI commands fast.
async function loadTui() {
  const [{ createCliRenderer }, { createRoot }, { App }, { InterviewApp }, { GeneratingView }, { ReviewView }, { FinalizeApp }, { PrdReviewView }] = await Promise.all([
    import("@opentui/core"),
    import("@opentui/react"),
    import("./tui/App.js"),
    import("./tui/InterviewApp.js"),
    import("./tui/GeneratingView.js"),
    import("./tui/ReviewView.js"),
    import("./tui/FinalizeApp.js"),
    import("./tui/PrdReviewView.js"),
  ]);
  return { createCliRenderer, createRoot, App, InterviewApp, GeneratingView, ReviewView, FinalizeApp, PrdReviewView };
}

const VERSION = "0.6.0";
const REPO = "Apostolos-Delis/synth";

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

async function applyTheme(): Promise<SynthConfig> {
  const config = await loadConfig(cwd);
  const { theme, spinnerFrames } = await resolveTheme(config);
  initTheme(theme, spinnerFrames);
  return config;
}

function log(msg: string): void {
  console.log(msg);
}

function logError(msg: string): void {
  console.error(fmt.error(msg));
}

function logSuccess(msg: string): void {
  console.log(fmt.success(msg));
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
    template = `[project]
name = "${name}"
branch = "feature/synth"

[agent]
name = "claude"
model = "opus"
timeout = 600000

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
  const allPlans = await listSessions(cwd);
  const plans = showAll
    ? allPlans
    : allPlans.filter((p) => p.status !== "completed" && p.status !== "finalized");

  if (plans.length === 0) {
    if (allPlans.length > 0) {
      log(fmt.dim(`All ${allPlans.length} session(s) are completed. Use 'synth ls --all' to show them.`));
    } else {
      log(fmt.dim("No sessions found. Run 'synth plan' to create one."));
    }
    return;
  }

  const label = showAll ? "Sessions (all)" : "Sessions";
  const hidden = allPlans.length - plans.length;
  const suffix = hidden > 0 ? ` ${ansi.muted}(${hidden} completed hidden, use --all)${ansi.reset}` : "";
  log(`${fmt.bold(label)}${suffix}\n`);
  log(
    `  ${ansi.muted}${"#".padEnd(4)} ${"ID".padEnd(25)} ${"Status".padEnd(12)} ${"Tasks".padEnd(10)} Created${ansi.reset}`,
  );
  log(`  ${ansi.muted}${"─".repeat(74)}${ansi.reset}`);

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
    log(
      `  ${ansi.primary}${String(i + 1).padEnd(4)}${ansi.reset}${plan.id.padEnd(25)} ${statusColor}${icon} ${plan.status.padEnd(10)}${ansi.reset} ${`${plan.tasksCompleted}/${plan.taskCount}`.padEnd(10)} ${date}`,
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
    log(fmt.dim("No active session. Run 'synth plan' to create one."));
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
  const config = await applyTheme();
  const json = JSON.stringify(config, null, 2);
  const colorized = json
    .replace(/"([^"]+)":/g, `${ansi.primary}"$1"${ansi.reset}:`)
    .replace(/: "([^"]+)"/g, `: ${ansi.success}"$1"${ansi.reset}`)
    .replace(/: (\d+)/g, `: ${ansi.warning}$1${ansi.reset}`)
    .replace(/: (true|false)/g, `: ${ansi.magenta}$1${ansi.reset}`);
  log(colorized);
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
  const config = await applyTheme();

  let plan;
  if (sessionId) {
    plan = await getSession(cwd, sessionId);
  } else {
    plan = await getMostRecentSession(cwd);
  }

  if (!plan) {
    logError("No session found. Run 'synth plan' first.");
    process.exit(1);
  }

  if (!(await fileExists(plan.paths.tasks))) {
    logError(`Session ${plan.metadata.id} has no tasks. Run 'synth plan' to generate them.`);
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

  log(
    `${fmt.bold("synth run")} ${ansi.muted}│${ansi.reset} ${fmt.label("session:", plan.metadata.id)} ${ansi.muted}│${ansi.reset} ${fmt.label("agent:", config.agent.name)} ${ansi.muted}│${ansi.reset} ${fmt.label("max:", `${config.execution.max_iterations} iterations`)}`,
  );
  log("");

  await updateSessionMetadata(cwd, plan.metadata.id, { status: "executing" });

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
    };

    // Pre-load historical outputs for tasks completed in previous sessions
    const completedTasks = taskFile.tasks.filter((t) => t.status === "done");
    if (completedTasks.length > 0) {
      buildIterationMap(plan.paths.progress).then(async (iterMap) => {
        if (!tuiData || iterMap.length === 0) return;
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

  const taskStartTimes = new Map<string, number>();

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
            taskStartTimes.set(event.taskId, Date.now());
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
              const elapsedSecs = Math.floor((Date.now() - startTime) / 1000);
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
            if (tuiData.currentTaskId && tuiData.currentTaskId in tuiData.taskOutputMap) {
              tuiData.taskOutputMap[tuiData.currentTaskId] += stripped;
            }
          }
          renderTui();
          // Record first-token-to-render latency for --profile reporting
          if (event.isFirstChunk && !firstTokenRendered) {
            firstTokenRendered = true;
            const renderMs = performance.now() - renderStart;
            globalTrace().recordPhase("tui:first-token-render", renderMs);
          }
          return; // already rendered above
        }
        case "agent:stderr":
          if (event.message) tuiData.output += stripAnsi(event.message);
          break;
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
    await updateSessionMetadata(cwd, plan.metadata.id, {
      status: finalState === "completed" ? "completed" : finalState === "blocked" ? "blocked" : "paused",
    });

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
        log(`\n${fmt.dim(`Run 'synth finalize ${plan.metadata.id}' to start finalize review.`)}`);
      }
    }

    if (notificationsEnabled) {
      const notif = await import("./notifications.js");

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
      const notif = await import("./notifications.js");
      notif.sendErrorNotification({
        errorSummary: String(err),
        tasksCompleted,
        durationMs,
      });
    }
  } finally {
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
        logError(`Finalize conversation state missing for session ${id}. Run 'synth finalize ${id}' to start a fresh review.`);
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
        rl.question(`Run finalize to review changes and create a PR? (Y/n) `, resolve);
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

    case "planning": {
      log(fmt.info(`Session ${id} is in planning phase. Run 'synth run ${id}' to start execution.`));
      return;
    }

    // executing, paused — fall through to execution resume below
  }

  const { loadRun } = await loadRunModule();
  const run = await loadRun(plan.paths);
  if (!run) {
    logError(`No run state found for session ${id}. Run 'synth run ${id}' to start execution.`);
    process.exit(1);
  }

  if (run.status === "completed") {
    log(fmt.info(`Execution is complete. Run 'synth finalize ${id}' to review and create a PR.`));
    return;
  }

  log(fmt.info(`Resuming session ${id} from iteration ${run.currentIteration}`));
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

  let prd: import("./interview/types.js").GeneratedPrd | null = null;
  const { id, paths } = { id: plan.metadata.id, paths: plan.paths };

  const interviewer = new interviewMod.Interviewer(agent, cwd, config.agent.model, async (messages) => {
    const state: import("./interview/types.js").InterviewState = {
      messages: messages as import("./interview/types.js").InterviewMessage[],
      interviewerHistory: messages as import("./interview/types.js").InterviewMessage[],
      prdPending: !prd,
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
            const extracted = interviewer.extractPrd(response);
            if (extracted) prd = extracted;
            return { response, done: !!extracted };
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

    if (!prd) {
      process.off("SIGINT", sigintHandler);
      cleanup();
      agent.dispose();
      return;
    }

    // Phase 2: PRD Review (same flow as cmdPlan)
    const extractedPrd = prd as import("./interview/types.js").GeneratedPrd;
    const prdMarkdown = interviewMod.prdToMarkdown(extractedPrd);
    const taskPrefix = await setSessionSlugAndPrefix(id, extractedPrd.title);

    let approvedPrdContent: string | null = null;
    const prdApproved = await new Promise<boolean>((resolve) => {
      planRoot.render(
        <tui.PrdReviewView
          prdMarkdown={prdMarkdown}
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
      log(`\nSession saved. Run later with: ${fmt.bold(`synth run ${id}`)}`);
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
      log(`\nSession saved. Run later with: ${fmt.bold(`synth run ${id}`)}`);
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

    while (!prd) {
      const userInput = await askQuestion();
      if (userInput === null) {
        agent.dispose();
        return;
      }

      const response = await interviewer.respond(userInput);
      log(`\n${ansi.magenta}Synth:${ansi.reset}`);
      log(response);
      prd = interviewer.extractPrd(response);

      if (prd) {
        log(`\n${ansi.primary}Does this all look good? Press Enter to generate the PRD and tasks, or type feedback to refine.${ansi.reset}`);
        const confirmation = await askQuestion();
        if (confirmation === null) {
          agent.dispose();
          return;
        }
        if (confirmation.trim()) {
          prd = null;
          const refinement = await interviewer.respond(confirmation);
          log(`\n${ansi.magenta}Synth:${ansi.reset}`);
          log(refinement);
          prd = interviewer.extractPrd(refinement);
        }
      }
    }

    // Continue with task generation
    await writeText(paths.prd, interviewMod.prdToMarkdown(prd));
    const taskPrefix = await setSessionSlugAndPrefix(id, prd.title);

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
      log(`\nSession saved. Run later with: ${fmt.bold(`synth run ${id}`)}`);
    }
  }
}

async function cmdPlan(sessionIdOrFlag?: string): Promise<void> {
  const config = await applyTheme();

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
          generateTasks(agent, paths.prd, config.project.name, config.project.branch, cwd, { model: config.agent.model, taskPrefix }),
          { successMessage: fmt.success("Tasks generated") },
        )
      : await (async () => {
          log("Generating tasks from PRD...");
          return generateTasks(agent, paths.prd, config.project.name, config.project.branch, cwd, { model: config.agent.model, taskPrefix });
        })();

    await saveTasks(paths.tasks, taskFile);
    await writeText(paths.progress, "## Codebase Patterns\n\n---\n\n");
    await updateSessionMetadata(cwd, id, {
      status: "planning",
      taskCount: taskFile.tasks.length,
    });

    logSuccess(
      `Generated ${taskFile.tasks.length} tasks. Run 'synth run ${id}' to start.`,
    );
    agent.dispose();
    return;
  }

  if (sessionIdOrFlag && sessionIdOrFlag !== "plan") {
    const plan = await getSession(cwd, sessionIdOrFlag);
    if (plan) {
      await cmdShow(sessionIdOrFlag);
      log(`\nTo execute: ${fmt.bold(`synth run ${sessionIdOrFlag}`)}`);
      return;
    }
  }

  const [{ getAgent }, interviewMod, { generateTasks }] = await Promise.all([
    loadAgentRegistry(),
    loadInterviewer(),
    loadPlanner(),
  ]);

  const agent = getAgent(config.agent.name);

  let prd: import("./interview/types.js").GeneratedPrd | null = null;

  // Create session early so we have paths for interview state persistence
  const { id, paths } = await createSession(cwd, "");

  const interviewer = new interviewMod.Interviewer(agent, cwd, config.agent.model, async (messages) => {
    const state: import("./interview/types.js").InterviewState = {
      messages: messages as import("./interview/types.js").InterviewMessage[],
      interviewerHistory: messages as import("./interview/types.js").InterviewMessage[],
      prdPending: !prd,
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
            const extracted = interviewer.extractPrd(response);
            if (extracted) prd = extracted;
            return { response, done: !!extracted };
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

    if (!prd) {
      process.off("SIGINT", sigintHandler);
      cleanup();
      agent.dispose();
      return;
    }

    // Phase 2: PRD Review (user can revise before task generation)
    const extractedPrd = prd as import("./interview/types.js").GeneratedPrd;
    const prdMarkdown = interviewMod.prdToMarkdown(extractedPrd);
    const taskPrefix = await setSessionSlugAndPrefix(id, extractedPrd.title);

    let approvedPrdContent: string | null = null;
    const prdApproved = await new Promise<boolean>((resolve) => {
      planRoot.render(
        <tui.PrdReviewView
          prdMarkdown={prdMarkdown}
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
      log(`\nSession saved. Run later with: ${fmt.bold(`synth run ${id}`)}`);
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
      log(`\nSession saved. Run later with: ${fmt.bold(`synth run ${id}`)}`);
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

    while (!prd) {
      const userInput = await askQuestion();
      if (userInput === null) {
        agent.dispose();
        return;
      }

      const response = await interviewer.respond(userInput);
      log(`\n${ansi.magenta}Synth:${ansi.reset}`);
      log(response);
      prd = interviewer.extractPrd(response);

      if (prd) {
        log(`\n${ansi.primary}Does this all look good? Press Enter to generate the PRD and tasks, or type feedback to refine.${ansi.reset}`);
        const confirmation = await askQuestion();
        if (confirmation === null) {
          agent.dispose();
          return;
        }
        if (confirmation.trim()) {
          prd = null;
          const refinement = await interviewer.respond(confirmation);
          log(`\n${ansi.magenta}Synth:${ansi.reset}`);
          log(refinement);
          prd = interviewer.extractPrd(refinement);
        }
      }
    }
  }

  // Non-TUI path continues here (TUI path returns early above)
  if (!prd) {
    agent.dispose();
    return;
  }

  await writeText(paths.prd, interviewMod.prdToMarkdown(prd));
  const taskPrefix = await setSessionSlugAndPrefix(id, prd.title);

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
      `\nSession saved. Run later with: ${fmt.bold(`synth run ${id}`)}`,
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
      // FinalizeApp auto-starts the orchestrator on mount and handles
      // all phase transitions (executeFixes, executePrCreation) internally.
      await new Promise<void>((resolve) => {
        root!.render(
          <tui.FinalizeApp
            orchestrator={orchestrator}
            agent={agent}
            config={config}
            sessionPaths={plan!.paths}
            cwd={cwd}
            onQuit={() => resolve()}
          />,
        );
      });
    } finally {
      process.off("SIGINT", sigintHandler);
      cleanup();
    }
  } else {
    // ── Non-TUI: automated finalize pipeline ──
    log(`${fmt.bold("synth finalize")} ${ansi.muted}─${ansi.reset} ${plan.metadata.id}\n`);

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

async function cmdSpawn(sessionIdOrFlag?: string): Promise<void> {
  await applyTheme();
  let sessionId: string | undefined;
  let doPlan = false;

  if (sessionIdOrFlag === "--plan") {
    doPlan = true;
  } else {
    sessionId = sessionIdOrFlag;
  }

  if (!sessionId && !doPlan) {
    const plan = await getMostRecentSession(cwd);
    if (!plan) {
      logError("No session found. Use 'synth spawn --plan' to start a new session.");
      process.exit(1);
    }
    sessionId = plan.metadata.id;
  }

  const wtName = sessionId ?? `synth-${Date.now().toString(36)}`;
  if (!/^[\w./-]+$/.test(wtName)) {
    logError(`Invalid session ID: ${wtName}`);
    process.exit(1);
  }
  const wtPath = join(cwd, ".worktrees", wtName);
  const branchName = `synth/${wtName}`;

  if (tuiEnabled) {
    const spinner = createSpinner("Creating worktree");
    const addHandle = spawn({
      cmd: ["git", "worktree", "add", wtPath, "-b", branchName],
      cwd,
    });
    const addResult = await addHandle.promise;
    if (addResult.exitCode !== 0) {
      spinner.stop(fmt.error(`Failed to create worktree: ${addResult.stderr}`));
      process.exit(1);
    }
    spinner.stop(fmt.success("Worktree created"));
  } else {
    log("Creating worktree...");
    const addHandle = spawn({
      cmd: ["git", "worktree", "add", wtPath, "-b", branchName],
      cwd,
    });
    const addResult = await addHandle.promise;
    if (addResult.exitCode !== 0) {
      logError(`Failed to create worktree: ${addResult.stderr}`);
      process.exit(1);
    }
  }

  const cmd = doPlan ? "synth plan" : `synth run ${sessionId}`;
  log(fmt.info(`Starting: cd ${wtPath} && ${cmd}`));

  const runHandle = spawn({
    cmd: ["bash", "-c", `cd "${wtPath}" && ${cmd}`],
    cwd: wtPath,
  });

  log(fmt.label("  PID:", String(runHandle.pid)));
  log(fmt.label("  Worktree:", wtPath));
  log(fmt.label("  Branch:", branchName));
}

async function cmdPs(): Promise<void> {
  const plans = await listSessions(cwd);
  const running = plans.filter((p) => p.status === "executing");

  if (running.length === 0) {
    log(fmt.dim("No running synth instances."));
    return;
  }

  log(fmt.bold("Running instances:") + "\n");
  for (const plan of running) {
    log(`  ${ansi.success}●${ansi.reset} ${plan.id} ${ansi.muted}─${ansi.reset} ${plan.description}`);
  }
}

async function cmdClean(): Promise<void> {
  const plans = await listSessions(cwd);
  const stale = plans.filter(
    (p) => p.status === "interviewing" && p.taskCount === 0,
  );

  if (stale.length === 0) {
    log(fmt.dim("Nothing to clean."));
    return;
  }

  log(fmt.bold(`Removing ${stale.length} abandoned session(s):\n`));
  for (const plan of stale) {
    const date = fmt.dim(new Date(plan.createdAt).toLocaleDateString());
    const deleted = await deleteSession(cwd, plan.id);
    if (deleted) {
      logSuccess(`${plan.id} ${ansi.muted}(interviewing, ${date})${ansi.reset}`);
    } else {
      logError(`${plan.id} — not found on disk`);
    }
  }
}

async function cmdUpdate(): Promise<void> {
  await applyTheme();
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

    const updateSpinner = createSpinner("Installing update");
    const handle = spawn({
      cmd: ["bash", "-c", `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`],
      cwd,
    });
    const result = await handle.promise;
    if (result.exitCode !== 0) {
      updateSpinner.stop(fmt.error(`Update failed: ${result.stderr}`));
      process.exit(1);
    }
    if (result.stdout) log(result.stdout);
    updateSpinner.stop(fmt.success(`Updated to v${latest}`));
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
    log("Updating...\n");

    const handle = spawn({
      cmd: ["bash", "-c", `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`],
      cwd,
    });
    const result = await handle.promise;
    if (result.exitCode !== 0) {
      logError(`Update failed: ${result.stderr}`);
      process.exit(1);
    }
    if (result.stdout) log(result.stdout);
    logSuccess(`Updated to v${latest}`);
  }
}

export function buildSummaryMarkdown(data: Omit<CompletionSummary, "summaryFilePath">): string {
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

function printCompletionSummary(data: CompletionSummary): void {
  const dur = formatDuration(data.totalDurationMs);
  log("");
  log(`${ansi.bold}${"─".repeat(60)}${ansi.reset}`);
  log(`${ansi.bold}Completion Summary${ansi.reset}  ${ansi.muted}${data.projectName} (${data.sessionId})${ansi.reset}`);
  log(`${ansi.bold}${"─".repeat(60)}${ansi.reset}`);
  log(`${fmt.label("Duration:", dur)}  ${fmt.label("Iterations:", String(data.totalIterations))}  ${fmt.label("Agent:", data.agentName)}`);
  log(`${ansi.success}✔ ${data.progress.done} done${ansi.reset}  ${ansi.error}✘ ${data.progress.failed} failed${ansi.reset}  ${ansi.muted}○ ${data.progress.open} open${ansi.reset}`);
  log("");

  for (const task of data.tasks) {
    const icon = STATUS_ICONS[task.status] ?? "○";
    const color = STATUS_COLORS[task.status] ?? ansi.muted;
    log(`  ${color}${icon}${ansi.reset} ${task.id} ${task.title}`);
  }

  if (data.commits.length > 0) {
    log(`\n${fmt.bold("Commits:")}`);
    for (const c of data.commits) {
      log(`  ${ansi.muted}${c}${ansi.reset}`);
    }
  }

  log(`\n${fmt.dim(`Summary saved to: ${data.summaryFilePath}`)}`);
}

async function main(): Promise<void> {
  switch (command) {
    case "init":
      await cmdInit();
      break;
    case "plan":
      await cmdPlan(await resolvePlanId(args[1]));
      break;
    case "run":
      await cmdRun(await resolvePlanId(args[1]));
      break;
    case "resume":
      await cmdResume(await resolvePlanId(args[1]));
      break;
    case "finalize":
      await cmdFinalize(await resolvePlanId(args[1]));
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
    case "themes":
      await cmdThemes();
      break;
    case "spawn":
      await cmdSpawn(await resolvePlanId(args[1]));
      break;
    case "ps":
      await cmdPs();
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
      log(`  ${ansi.primary}plan${ansi.reset} ${ansi.muted}[--prd <path>]${ansi.reset}    Interview → generate tasks → execute`);
      log(`  ${ansi.primary}run${ansi.reset} ${ansi.muted}[<session-id>]${ansi.reset}     Execute the task loop`);
      log(`  ${ansi.primary}resume${ansi.reset} ${ansi.muted}[<session-id>]${ansi.reset}  Resume paused session`);
      log(`  ${ansi.primary}finalize${ansi.reset} ${ansi.muted}[<session-id>]${ansi.reset} Self-review → format → split → PR`);
      log(`  ${ansi.primary}spawn${ansi.reset} ${ansi.muted}[<session-id>]${ansi.reset}   Run session in background worktree`);

      log(`\n${ansi.bold}Inspect:${ansi.reset}`);
      log(`  ${ansi.primary}ls${ansi.reset} ${ansi.muted}[--all]${ansi.reset}              List sessions (hides completed)`);
      log(`  ${ansi.primary}show${ansi.reset} ${ansi.muted}<session-id>${ansi.reset}       Show session details`);
      log(`  ${ansi.primary}status${ansi.reset} ${ansi.muted}[<session-id>]${ansi.reset}   Session status`);
      log(`  ${ansi.primary}ps${ansi.reset}                       List running instances`);
      log(`  ${ansi.primary}config${ansi.reset}                   Display configuration`);
      log(`  ${ansi.primary}themes${ansi.reset}                   List themes and spinners`);

      log(`\n${ansi.bold}System:${ansi.reset}`);
      log(`  ${ansi.primary}init${ansi.reset}                     Create synth.toml`);
      log(`  ${ansi.primary}clean${ansi.reset}                    Remove abandoned sessions`);
      log(`  ${ansi.primary}update${ansi.reset}                   Update to latest version`);
      log(`  ${ansi.primary}version${ansi.reset}                  Show version`);

      log(`\n${ansi.bold}Options:${ansi.reset}`);
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
