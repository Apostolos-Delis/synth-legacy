#!/usr/bin/env bun

import { join } from "node:path";
import { loadConfig } from "./config/loader.js";
import {
  createPlan,
  getPlan,
  listPlans,
  getMostRecentPlan,
  updatePlanMetadata,
  deletePlan,
} from "./plans/registry.js";
import { loadTasks, saveTasks, getProgress, resetOrphanedTasks } from "./tasks/store.js";
import { generateTasks } from "./tasks/planner.js";
import { getAgent } from "./agents/registry.js";
import { Engine } from "./engine/engine.js";
import {
  createSession,
  loadSession,
  acquireLock,
  releaseLock,
  endSession,
} from "./session/session.js";
import { Interviewer, prdToMarkdown, WELCOME_MESSAGE } from "./interview/interviewer.js";
import type { GeneratedPrd } from "./interview/types.js";
import { finalize } from "./finalize/finalize.js";
import { writeText, readText, fileExists } from "./utils/fs.js";
import { spawn } from "./utils/process.js";
import { ansi, fmt, STATUS_ICONS, STATUS_COLORS, PRIORITY_COLORS } from "./tui/theme.js";
import { createSpinner, withSpinner } from "./tui/spinner.js";
import type { TuiEngineData, TuiContext } from "./tui/types.js";

// TUI imports are loaded dynamically to keep non-TUI commands fast.
async function loadTui() {
  const [{ createCliRenderer }, { createRoot }, { App }, { InterviewApp }, { GeneratingView }, { ReviewView }] = await Promise.all([
    import("@opentui/core"),
    import("@opentui/react"),
    import("./tui/App.js"),
    import("./tui/InterviewApp.js"),
    import("./tui/GeneratingView.js"),
    import("./tui/ReviewView.js"),
  ]);
  return { createCliRenderer, createRoot, App, InterviewApp, GeneratingView, ReviewView };
}

const VERSION = "0.1.2";
const REPO = "Apostolos-Delis/synth";

const cwd = process.cwd();
const args = process.argv.slice(2);
const command = args[0];

const tuiEnabled = process.stdout.isTTY === true && !args.includes("--no-tui");

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
    const allPlans = await listPlans(cwd);
    const plans = allPlans.filter((p) => p.status !== "completed" && p.status !== "finalized");
    const idx = parseInt(input, 10) - 1;
    if (idx < 0 || idx >= plans.length) {
      logError(`Plan #${input} not found. Run 'synth ls' to see available plans.`);
      process.exit(1);
    }
    return plans[idx].id;
  }
  return input;
}

async function cmdLs(): Promise<void> {
  const showAll = args.includes("--all") || args.includes("-a");
  const allPlans = await listPlans(cwd);
  const plans = showAll
    ? allPlans
    : allPlans.filter((p) => p.status !== "completed" && p.status !== "finalized");

  if (plans.length === 0) {
    if (allPlans.length > 0) {
      log(fmt.dim(`All ${allPlans.length} plan(s) are completed. Use 'synth ls --all' to show them.`));
    } else {
      log(fmt.dim("No plans found. Run 'synth plan' to create one."));
    }
    return;
  }

  const label = showAll ? "Plans (all)" : "Plans";
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

async function cmdShow(planId: string): Promise<void> {
  const plan = await getPlan(cwd, planId);
  if (!plan) {
    logError(`Plan '${planId}' not found`);
    process.exit(1);
  }

  log(fmt.bold(`Plan: ${plan.metadata.id}`));
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

async function cmdStatus(planId?: string): Promise<void> {
  let plan;
  if (planId) {
    plan = await getPlan(cwd, planId);
  } else {
    plan = await getMostRecentPlan(cwd);
  }

  if (!plan) {
    log(fmt.dim("No active plan. Run 'synth plan' to create one."));
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

  const session = await loadSession(plan.paths);
  if (session) {
    log(fmt.label("Session:", `${session.status} (iteration ${session.currentIteration})`));
  }
}

async function cmdConfig(): Promise<void> {
  const config = await loadConfig(cwd);
  const json = JSON.stringify(config, null, 2);
  const colorized = json
    .replace(/"([^"]+)":/g, `${ansi.primary}"$1"${ansi.reset}:`)
    .replace(/: "([^"]+)"/g, `: ${ansi.success}"$1"${ansi.reset}`)
    .replace(/: (\d+)/g, `: ${ansi.warning}$1${ansi.reset}`)
    .replace(/: (true|false)/g, `: ${ansi.magenta}$1${ansi.reset}`);
  log(colorized);
}

async function cmdRun(planId?: string, startIteration = 0, tuiContext?: TuiContext): Promise<void> {
  const config = await loadConfig(cwd);

  let plan;
  if (planId) {
    plan = await getPlan(cwd, planId);
  } else {
    plan = await getMostRecentPlan(cwd);
  }

  if (!plan) {
    logError("No plan found. Run 'synth plan' first.");
    process.exit(1);
  }

  if (!(await fileExists(plan.paths.tasks))) {
    logError(`Plan ${plan.metadata.id} has no tasks. Run 'synth plan' to generate them.`);
    process.exit(1);
  }

  const taskFile = await loadTasks(plan.paths.tasks);
  const cleaned = resetOrphanedTasks(taskFile);
  if (cleaned !== taskFile) {
    await saveTasks(plan.paths.tasks, cleaned);
    log(fmt.warn("Reset orphaned in_progress tasks from previous session"));
  }

  const agent = getAgent(config.agent.name);
  const detection = await agent.detect();
  if (!detection.available) {
    logError(`Agent '${config.agent.name}' not available: ${detection.error}`);
    process.exit(1);
  }

  const session = await createSession(
    plan.paths,
    plan.metadata.id,
    config.agent.name,
    config.execution.max_iterations,
    cwd,
  );

  const locked = await acquireLock(plan.paths, session.id);
  if (!locked) {
    logError("Another synth session is already running for this plan.");
    process.exit(1);
  }

  log(
    `${fmt.bold("synth run")} ${ansi.muted}│${ansi.reset} ${fmt.label("plan:", plan.metadata.id)} ${ansi.muted}│${ansi.reset} ${fmt.label("agent:", config.agent.name)} ${ansi.muted}│${ansi.reset} ${fmt.label("max:", `${config.execution.max_iterations} iterations`)}`,
  );
  log("");

  await updatePlanMetadata(cwd, plan.metadata.id, { status: "executing" });

  const fallbackAgent = config.agent.fallback
    ? getAgent(config.agent.fallback.name)
    : null;

  const engine = new Engine(config, agent, fallbackAgent, plan.paths, cwd);

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
      renderer = await tui.createCliRenderer();
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
      planId: plan.metadata.id,
      startTime: Date.now(),
      interviewMessages: [],
      isThinking: false,
    };
  }

  const renderTui = () => {
    if (root && tuiData && App) {
      root.render(<App {...tuiData} onQuit={() => cleanup().then(() => process.exit(0))} />);
    }
  };

  if (tuiEnabled) {
    engine.on((event) => {
      if (!tuiData) return;
      switch (event.type) {
        case "iteration:start":
          tuiData.iteration = event.iteration ?? tuiData.iteration;
          tuiData.currentTaskId = event.taskId ?? null;
          tuiData.output = "";
          break;
        case "task:complete":
        case "task:failed": {
          const task = tuiData.tasks.find((t) => t.id === event.taskId);
          if (task) task.status = event.type === "task:complete" ? "done" : "failed";
          break;
        }
        case "agent:stdout":
          if (event.message) tuiData.output += event.message;
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
        case "complete":
          log(`\n${fmt.success("All tasks complete!")}`);
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
    await endSession(plan!.paths, "interrupted");
    await updatePlanMetadata(cwd, plan!.metadata.id, { status: "paused" });
    if (!tuiEnabled) {
      log(`\n${fmt.warn(`Session interrupted. Resume with: synth resume ${plan!.metadata.id}`)}`);
    }
  };

  const onSigInt = () => { cleanup().then(() => process.exit(0)); };
  const onSigTerm = () => { cleanup().then(() => process.exit(0)); };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  try {
    await engine.run(startIteration);
    const finalState = engine.getState();
    await endSession(plan.paths, finalState === "completed" ? "completed" : "paused");
    await updatePlanMetadata(cwd, plan.metadata.id, {
      status: finalState === "completed" ? "completed" : finalState === "blocked" ? "blocked" : "paused",
    });
  } catch (err) {
    await endSession(plan.paths, "failed");
    await updatePlanMetadata(cwd, plan.metadata.id, { status: "failed" });
    if (!tuiEnabled) logError(`Engine error: ${err}`);
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    if (ownsRenderer) {
      if (root) root.unmount();
      if (renderer) renderer.destroy();
    }
    await releaseLock(plan.paths);
    agent.dispose();
    fallbackAgent?.dispose();
  }
}

async function cmdResume(planId?: string): Promise<void> {
  let plan;
  if (planId) {
    plan = await getPlan(cwd, planId);
  } else {
    plan = await getMostRecentPlan(cwd);
  }

  if (!plan) {
    logError("No plan found to resume.");
    process.exit(1);
  }

  const session = await loadSession(plan.paths);
  if (!session) {
    logError("No session found. Run 'synth run' instead.");
    process.exit(1);
  }

  if (session.status === "completed") {
    log(fmt.info("This plan is already completed."));
    return;
  }

  log(fmt.info(`Resuming plan ${plan.metadata.id} from iteration ${session.currentIteration}`));
  await cmdRun(plan.metadata.id, session.currentIteration);
}

async function cmdPlan(planIdOrFlag?: string): Promise<void> {
  const config = await loadConfig(cwd);

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
    const { id, paths } = await createPlan(cwd, "Generated from PRD");

    await writeText(paths.prd, prdContent);
    log(fmt.info(`Created plan: ${id}`));

    const agent = getAgent(config.agent.name);

    const taskFile = tuiEnabled
      ? await withSpinner("Generating tasks from PRD", () =>
          generateTasks(agent, prdContent, config.project.name, config.project.branch, cwd, config.agent.model),
          { successMessage: fmt.success("Tasks generated") },
        )
      : await (async () => {
          log("Generating tasks from PRD...");
          return generateTasks(agent, prdContent, config.project.name, config.project.branch, cwd, config.agent.model);
        })();

    await saveTasks(paths.tasks, taskFile);
    await writeText(paths.progress, "## Codebase Patterns\n\n---\n\n");
    await updatePlanMetadata(cwd, id, {
      status: "planning",
      taskCount: taskFile.tasks.length,
    });

    logSuccess(
      `Generated ${taskFile.tasks.length} tasks. Run 'synth run ${id}' to start.`,
    );
    agent.dispose();
    return;
  }

  if (planIdOrFlag && planIdOrFlag !== "plan") {
    const plan = await getPlan(cwd, planIdOrFlag);
    if (plan) {
      await cmdShow(planIdOrFlag);
      log(`\nTo execute: ${fmt.bold(`synth run ${planIdOrFlag}`)}`);
      return;
    }
  }

  const agent = getAgent(config.agent.name);
  const interviewer = new Interviewer(agent, cwd, config.agent.model);

  let prd: import("./interview/types.js").GeneratedPrd | null = null;

  if (tuiEnabled) {
    const tui = await loadTui();
    const planRenderer = await tui.createCliRenderer({ exitOnCtrlC: false });
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

    // Phase 2: Task Generation (keep renderer alive)
    const extractedPrd = prd as GeneratedPrd;
    const { id, paths } = await createPlan(cwd, "");
    const prdMarkdown = prdToMarkdown(extractedPrd);
    await writeText(paths.prd, prdMarkdown);
    await updatePlanMetadata(cwd, id, { description: extractedPrd.title });

    let streamOutput = "";
    planRoot.render(<tui.GeneratingView output={streamOutput} />);

    let taskFile;
    try {
      taskFile = await generateTasks(
        agent, prdMarkdown, config.project.name, config.project.branch || `synth/${id}`, cwd, config.agent.model,
        (chunk) => {
          streamOutput += chunk;
          planRoot.render(<tui.GeneratingView output={streamOutput} />);
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
    await updatePlanMetadata(cwd, id, {
      status: "planning",
      taskCount: taskFile.tasks.length,
    });

    // Phase 3: Task Review
    const confirmed = await new Promise<boolean>((resolve) => {
      planRoot.render(
        <tui.ReviewView
          tasks={taskFile.tasks}
          planId={id}
          onConfirm={() => resolve(true)}
          onDecline={() => resolve(false)}
        />,
      );
    });

    process.off("SIGINT", sigintHandler);

    if (!confirmed) {
      cleanup();
      agent.dispose();
      log(`\nPlan saved. Run later with: ${fmt.bold(`synth run ${id}`)}`);
      return;
    }

    // Phase 4: Execution (reuse renderer+root)
    agent.dispose();
    await cmdRun(id, 0, { renderer: planRenderer, root: planRoot });
    cleanup();
    return;
  } else {
    log(`\n${ansi.magenta}Synth:${ansi.reset}`);
    log(WELCOME_MESSAGE);

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
    }
  }

  // Non-TUI path continues here (TUI path returns early above)
  if (!prd) {
    agent.dispose();
    return;
  }

  const { id, paths } = await createPlan(cwd, "");
  const prdMarkdown = prdToMarkdown(prd);
  await writeText(paths.prd, prdMarkdown);
  await updatePlanMetadata(cwd, id, { description: prd.title });

  logSuccess(`PRD saved to ${paths.prd}`);

  log("Generating tasks...\n");
  const taskFile = await generateTasks(agent, prdMarkdown, config.project.name, config.project.branch || `synth/${id}`, cwd, config.agent.model);

  await saveTasks(paths.tasks, taskFile);
  await writeText(paths.progress, "## Codebase Patterns\n\n---\n\n");
  await updatePlanMetadata(cwd, id, {
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
      `\nPlan saved. Run later with: ${fmt.bold(`synth run ${id}`)}`,
    );
  }
}

async function cmdFinalize(planId?: string): Promise<void> {
  const config = await loadConfig(cwd);

  let plan;
  if (planId) {
    plan = await getPlan(cwd, planId);
  } else {
    plan = await getMostRecentPlan(cwd);
  }

  if (!plan) {
    logError("No plan found to finalize.");
    process.exit(1);
  }

  log(`${fmt.bold("synth finalize")} ${ansi.muted}─${ansi.reset} ${plan.metadata.id}\n`);

  const agent = getAgent(config.agent.name);

  const result = tuiEnabled
    ? await withSpinner("Finalizing", () => finalize(config, agent, plan!.paths, cwd))
    : await finalize(config, agent, plan.paths, cwd);

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
    await updatePlanMetadata(cwd, plan.metadata.id, { status: "finalized" });
  }
}

async function cmdSpawn(planIdOrFlag?: string): Promise<void> {
  let planId: string | undefined;
  let doPlan = false;

  if (planIdOrFlag === "--plan") {
    doPlan = true;
  } else {
    planId = planIdOrFlag;
  }

  if (!planId && !doPlan) {
    const plan = await getMostRecentPlan(cwd);
    if (!plan) {
      logError("No plan found. Use 'synth spawn --plan' to start a new plan.");
      process.exit(1);
    }
    planId = plan.metadata.id;
  }

  const wtName = planId ?? `synth-${Date.now().toString(36)}`;
  if (!/^[\w./-]+$/.test(wtName)) {
    logError(`Invalid plan ID: ${wtName}`);
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

  const cmd = doPlan ? "synth plan" : `synth run ${planId}`;
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
  const plans = await listPlans(cwd);
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
  const plans = await listPlans(cwd);
  const stale = plans.filter(
    (p) => p.status === "interviewing" && p.taskCount === 0,
  );

  if (stale.length === 0) {
    log(fmt.dim("Nothing to clean."));
    return;
  }

  log(fmt.bold(`Removing ${stale.length} abandoned plan(s):\n`));
  for (const plan of stale) {
    const date = fmt.dim(new Date(plan.createdAt).toLocaleDateString());
    const deleted = await deletePlan(cwd, plan.id);
    if (deleted) {
      logSuccess(`${plan.id} ${ansi.muted}(interviewing, ${date})${ansi.reset}`);
    } else {
      logError(`${plan.id} — not found on disk`);
    }
  }
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
        logError("Usage: synth show <plan-id>");
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
      log(`  ${ansi.primary}run${ansi.reset} ${ansi.muted}[<plan-id>]${ansi.reset}        Execute the task loop`);
      log(`  ${ansi.primary}resume${ansi.reset} ${ansi.muted}[<plan-id>]${ansi.reset}     Resume paused session`);
      log(`  ${ansi.primary}finalize${ansi.reset} ${ansi.muted}[<plan-id>]${ansi.reset}   Self-review → format → split → PR`);
      log(`  ${ansi.primary}spawn${ansi.reset} ${ansi.muted}[<plan-id>]${ansi.reset}      Run plan in background worktree`);

      log(`\n${ansi.bold}Inspect:${ansi.reset}`);
      log(`  ${ansi.primary}ls${ansi.reset} ${ansi.muted}[--all]${ansi.reset}              List plans (hides completed)`);
      log(`  ${ansi.primary}show${ansi.reset} ${ansi.muted}<plan-id>${ansi.reset}          Show plan details`);
      log(`  ${ansi.primary}status${ansi.reset} ${ansi.muted}[<plan-id>]${ansi.reset}      Plan/session status`);
      log(`  ${ansi.primary}ps${ansi.reset}                       List running instances`);
      log(`  ${ansi.primary}config${ansi.reset}                   Display configuration`);

      log(`\n${ansi.bold}System:${ansi.reset}`);
      log(`  ${ansi.primary}init${ansi.reset}                     Create synth.toml`);
      log(`  ${ansi.primary}clean${ansi.reset}                    Remove abandoned plans`);
      log(`  ${ansi.primary}update${ansi.reset}                   Update to latest version`);
      log(`  ${ansi.primary}version${ansi.reset}                  Show version`);

      log(`\n${ansi.bold}Options:${ansi.reset}`);
      log(`  ${ansi.muted}--no-tui${ansi.reset}                 Disable TUI (plain text output)`);
      break;
    }
    default:
      logError(`Unknown command: ${command}`);
      log(`Run '${ansi.primary}synth help${ansi.reset}' for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  logError(String(err));
  process.exit(1);
});
