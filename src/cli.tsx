#!/usr/bin/env bun

import { join } from "node:path";
import { loadConfig } from "./config/loader.js";
import type { SynthConfig } from "./config/types.js";
import { getPlatform, type SleepInhibitor } from "./platform/index.js";
import {
  createSession,
  getSession,
  listSessions,
  getMostRecentSession,
  updateSessionMetadata,
  deleteSession,
} from "./sessions/registry.js";
import { deriveSessionSlug, deriveTaskPrefix } from "./sessions/slug.js";
import { loadTasks, saveTasks, getProgress, resetOrphanedTasks, allTasksDone } from "./tasks/store.js";
import { writeText, readText, readJson, fileExists, writeJson, removeFile } from "./utils/fs.js";
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
import { TokenAccumulator } from "./engine/tokens.js";
import type { IterationResult } from "./engine/types.js";

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
    checkLock: mod.checkLock,
  };
}

async function loadInterviewer() {
  const { Interviewer, extractPrdTitle, WELCOME_MESSAGE } = await import("./interview/interviewer.js");
  return { Interviewer, extractPrdTitle, WELCOME_MESSAGE };
}

async function loadPlanner() {
  const { generateTasks } = await import("./tasks/planner.js");
  return { generateTasks };
}

async function loadFinalize() {
  const { finalize } = await import("./finalize/finalize.js");
  return { finalize };
}

async function loadReviewOrchestrator() {
  const { ReviewOrchestrator } = await import("./review/orchestrator.js");
  return { ReviewOrchestrator };
}

async function loadParallelCoordinator() {
  const { ParallelCoordinator } = await import("./parallel/coordinator.js");
  const { analyzeTaskGraph } = await import("./parallel/task-graph.js");
  return { ParallelCoordinator, analyzeTaskGraph };
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

const VERSION = "0.7.1";
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

// Parse --parallel [N] flag: --parallel with no value defers to config.parallel.max_workers
const parallelIndex = args.indexOf("--parallel");
let parallelMode = false;
let parallelWorkers: number | undefined;
if (parallelIndex !== -1) {
  parallelMode = true;
  const next = args[parallelIndex + 1];
  if (next && /^\d+$/.test(next)) {
    parallelWorkers = parseInt(next, 10);
  }
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
      log(fmt.dim("No sessions found. Run 'synth start' to create one."));
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
  if (args.includes("--edit")) {
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
  const config = await applyTheme();

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

  if (!(await fileExists(plan.paths.tasks))) {
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
        fmt.warn(
          `Parallel mode: only ${actionableTasks.length} actionable task(s) with max parallelism ${analysis.maxParallelism} — falling back to serial execution`,
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
        },
        synthConfig: config,
        agent,
        fallbackAgent: parallelFallbackAgent,
      });

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
            logError(`Merge failed for task ${event.taskId}`);
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

      try {
        const result = await coordinator.run();
        log(
          fmt.info(
            `Parallel result: ${result.mergedTaskIds.length} merged, ${result.failedTaskIds.length} failed`,
          ),
        );
      } finally {
        await runMod.releaseLock(plan.paths);
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
      taskElapsedMs: {},
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

async function cmdStart(sessionIdOrFlag?: string): Promise<void> {
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

  const interviewer = new interviewMod.Interviewer(agent, cwd, config.agent.model, async (messages) => {
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
      type FinalizeYield = "quit" | "parallel-execute";

      // Yield loop: FinalizeApp can yield back to cmdFinalize for parallel execution,
      // then we remount FinalizeApp to continue from the recheck/PR phase.
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
              onParallelExecute={() => resolve("parallel-execute")}
            />,
          );
        });

        if (action === "quit") {
          running = false;
          break;
        }

        if (action === "parallel-execute") {
          // 1. Convert fixes to tasks
          const { fixTasksToTasks } = await import("./finalize/fix-converter.js");
          const { createInitialTuiState, applyParallelEvent, buildFixParallelTuiData } = await import("./finalize/parallel-bridge.js");
          const { ParallelCoordinator } = await loadParallelCoordinator();

          const fixes = orchestrator.getConfirmedFixes();
          const tasks = fixTasksToTasks(fixes, cwd);

          // 2. Create coordinator
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

          // 3. Build TUI state and mount App with parallel props
          const tuiData = buildFixParallelTuiData(tasks, config, plan!.metadata.id);
          const parallelState = createInitialTuiState(tasks.length);

          const renderParallelTui = () => {
            root!.render(
              <tui.App
                {...tuiData}
                parallel={parallelState.header}
                workers={parallelState.workers}
                mergeItems={parallelState.mergeItems}
                conflict={parallelState.conflict}
                onQuit={() => coordinator.abort()}
              />,
            );
          };

          // Throttle renders to ~60fps (same pattern as main execution path)
          let parallelRenderScheduled = false;
          const renderParallelTuiThrottled = () => {
            if (parallelRenderScheduled) return;
            parallelRenderScheduled = true;
            setTimeout(() => {
              parallelRenderScheduled = false;
              renderParallelTui();
            }, 16);
          };

          coordinator.on((event) => {
            applyParallelEvent(event, parallelState, () =>
              coordinator.getWorkerDisplayStates(),
            );
            renderParallelTuiThrottled();
          });

          renderParallelTui();

          // Deregister our SIGINT handler — coordinator manages its own
          // graceful shutdown (worktree cleanup, worker teardown).
          process.off("SIGINT", sigintHandler);
          let result;
          try {
            result = await coordinator.run();
          } finally {
            process.on("SIGINT", sigintHandler);
          }

          // 4. Fall back to sequential if coordinator says serial
          if (result.serial) {
            await orchestrator.executeFixes(agent, config, plan!.paths, () => {});
          } else {
            // 5. Tell orchestrator fixes are done, advance to recheck
            await orchestrator.completeFixExecution(
              result.mergedTaskIds.length,
              result.failedTaskIds.length,
              agent,
              config,
              plan!.paths,
              () => {},
            );
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

async function cmdSpawn(sessionIdOrFlag?: string): Promise<void> {
  await applyTheme();
  let sessionId: string | undefined;
  let doStart = false;

  if (sessionIdOrFlag === "--start") {
    doStart = true;
  } else {
    sessionId = sessionIdOrFlag;
  }

  if (!sessionId && !doStart) {
    const plan = await getMostRecentSession(cwd);
    if (!plan) {
      logError("No session found. Use 'synth spawn --start' to start a new session.");
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

  const cmd = doStart ? "synth start" : `synth resume ${sessionId}`;
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
      log(`  ${ansi.primary}start${ansi.reset} ${ansi.muted}[--prd <path>]${ansi.reset}   Interview → generate tasks → execute → PR`);
      log(`  ${ansi.primary}resume${ansi.reset} ${ansi.muted}[<session-id>]${ansi.reset}  Resume a paused or interrupted session`);
      log(`  ${ansi.primary}spawn${ansi.reset} ${ansi.muted}[<session-id>]${ansi.reset}   Run session in background worktree`);

      log(`\n${ansi.bold}Inspect:${ansi.reset}`);
      log(`  ${ansi.primary}ls${ansi.reset} ${ansi.muted}[--all]${ansi.reset}              List sessions (hides completed)`);
      log(`  ${ansi.primary}show${ansi.reset} ${ansi.muted}<session-id>${ansi.reset}       Show session details`);
      log(`  ${ansi.primary}status${ansi.reset} ${ansi.muted}[<session-id>]${ansi.reset}   Session status`);
      log(`  ${ansi.primary}ps${ansi.reset}                       List running instances`);
      log(`  ${ansi.primary}config${ansi.reset} ${ansi.muted}[--edit]${ansi.reset}          Display or edit configuration`);
      log(`  ${ansi.primary}doctor${ansi.reset}                   Validate environment setup`);
      log(`  ${ansi.primary}themes${ansi.reset}                   List themes and spinners`);

      log(`\n${ansi.bold}System:${ansi.reset}`);
      log(`  ${ansi.primary}init${ansi.reset}                     Create synth.toml`);
      log(`  ${ansi.primary}clean${ansi.reset}                    Remove abandoned sessions`);
      log(`  ${ansi.primary}update${ansi.reset}                   Update to latest version`);
      log(`  ${ansi.primary}version${ansi.reset}                  Show version`);

      log(`\n${ansi.bold}Options:${ansi.reset}`);
      log(`  ${ansi.muted}--parallel${ansi.reset} ${ansi.muted}[N]${ansi.reset}           Enable parallel execution (default: 8 workers)`);
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
