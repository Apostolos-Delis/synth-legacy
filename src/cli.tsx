#!/usr/bin/env bun

import { join } from "node:path";
import { loadConfig } from "./config/loader.js";
import {
  createPlan,
  getPlan,
  listPlans,
  getMostRecentPlan,
  updatePlanMetadata,
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
import { Interviewer, prdToMarkdown } from "./interview/interviewer.js";
import { finalize } from "./finalize/finalize.js";
import { writeText, readText, fileExists } from "./utils/fs.js";
import { spawn } from "./utils/process.js";
import { colors, STATUS_ICONS, STATUS_COLORS, PRIORITY_COLORS } from "./tui/theme.js";

const VERSION = "0.1.0";
const REPO = "Apostolos-Delis/synth";

const cwd = process.cwd();
const args = process.argv.slice(2);
const command = args[0];

function log(msg: string): void {
  console.log(msg);
}

function logError(msg: string): void {
  console.error(`${colors.error}error:${colors.reset} ${msg}`);
}

function logSuccess(msg: string): void {
  console.log(`${colors.success}${msg}${colors.reset}`);
}

async function cmdInit(): Promise<void> {
  const configPath = join(cwd, "synth.toml");
  if (await fileExists(configPath)) {
    log("synth.toml already exists");
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
model = "sonnet"
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

async function cmdLs(): Promise<void> {
  const plans = await listPlans(cwd);
  if (plans.length === 0) {
    log("No plans found for this repo. Run 'synth plan' to create one.");
    return;
  }

  log(`${colors.bold}Plans for this repo:${colors.reset}\n`);
  log(
    `  ${"ID".padEnd(25)} ${"Status".padEnd(12)} ${"Tasks".padEnd(10)} Created`,
  );
  log(`  ${"-".repeat(70)}`);

  for (const plan of plans) {
    const statusColor =
      plan.status === "completed"
        ? colors.success
        : plan.status === "executing"
          ? colors.primary
          : plan.status === "failed" || plan.status === "blocked"
            ? colors.error
            : colors.muted;
    const date = new Date(plan.createdAt).toLocaleDateString();
    log(
      `  ${plan.id.padEnd(25)} ${statusColor}${plan.status.padEnd(12)}${colors.reset} ${`${plan.tasksCompleted}/${plan.taskCount}`.padEnd(10)} ${date}`,
    );
  }
}

async function cmdShow(planId: string): Promise<void> {
  const plan = await getPlan(cwd, planId);
  if (!plan) {
    logError(`Plan '${planId}' not found`);
    process.exit(1);
  }

  log(`${colors.bold}Plan: ${plan.metadata.id}${colors.reset}`);
  log(`Status: ${plan.metadata.status}`);
  log(`Created: ${plan.metadata.createdAt}`);
  log(`Updated: ${plan.metadata.updatedAt}`);
  log(`Description: ${plan.metadata.description}`);
  log("");

  if (await fileExists(plan.paths.tasks)) {
    const taskFile = await loadTasks(plan.paths.tasks);
    const progress = getProgress(taskFile);
    log(
      `${colors.bold}Tasks:${colors.reset} ${progress.done}/${progress.total} done, ${progress.failed} failed, ${progress.open} open`,
    );
    log("");
    for (const task of taskFile.tasks) {
      const icon = STATUS_ICONS[task.status] ?? "?";
      const color = STATUS_COLORS[task.status] ?? colors.muted;
      log(`  ${color}${icon}${colors.reset} ${task.id} ${task.title}`);
    }
  }

  if (await fileExists(plan.paths.prd)) {
    log(`\n${colors.bold}PRD:${colors.reset} ${plan.paths.prd}`);
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
    log("No active plan. Run 'synth plan' to create one.");
    return;
  }

  log(`${colors.bold}${plan.metadata.id}${colors.reset} — ${plan.metadata.status}`);

  if (await fileExists(plan.paths.tasks)) {
    const taskFile = await loadTasks(plan.paths.tasks);
    const progress = getProgress(taskFile);
    const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
    const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
    log(`Progress: [${bar}] ${pct}% (${progress.done}/${progress.total})`);
  }

  const session = await loadSession(plan.paths);
  if (session) {
    log(`Session: ${session.status} (iteration ${session.currentIteration})`);
  }
}

async function cmdConfig(): Promise<void> {
  const config = await loadConfig(cwd);
  log(JSON.stringify(config, null, 2));
}

async function cmdRun(planId?: string, startIteration = 0): Promise<void> {
  const config = await loadConfig(cwd);

  // Resolve plan
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

  // Reset orphaned in_progress tasks from crashed sessions
  const taskFile = await loadTasks(plan.paths.tasks);
  const cleaned = resetOrphanedTasks(taskFile);
  if (cleaned !== taskFile) {
    await saveTasks(plan.paths.tasks, cleaned);
    log(`${colors.warning}Reset orphaned in_progress tasks from previous session${colors.reset}`);
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
    `${colors.bold}synth run${colors.reset} ${colors.muted}│${colors.reset} plan: ${plan.metadata.id} ${colors.muted}│${colors.reset} agent: ${config.agent.name} ${colors.muted}│${colors.reset} max: ${config.execution.max_iterations} iterations`,
  );
  log("");

  await updatePlanMetadata(cwd, plan.metadata.id, { status: "executing" });

  const fallbackAgent = config.agent.fallback
    ? getAgent(config.agent.fallback.name)
    : null;

  const engine = new Engine(config, agent, fallbackAgent, plan.paths, cwd);

  // Event logging (non-TUI mode — plain text output)
  engine.on((event) => {
    switch (event.type) {
      case "iteration:start":
        log(
          `\n${colors.bold}━━━ Iteration ${event.iteration} ━━━${colors.reset} task: ${event.taskId}`,
        );
        break;
      case "task:complete":
        logSuccess(`  ✓ ${event.taskId}: ${event.message}`);
        break;
      case "task:failed":
        logError(`  ✗ ${event.taskId}: ${event.message}`);
        break;
      case "backpressure:pass":
        log(`  ${colors.success}✓ backpressure passed${colors.reset}`);
        break;
      case "backpressure:fail":
        log(`  ${colors.error}✗ backpressure failed: ${event.message}${colors.reset}`);
        break;
      case "circuit:trip":
        logError(`Circuit breaker: ${event.message}`);
        break;
      case "rate-limit:detected":
        log(`  ${colors.warning}⏳ ${event.message}${colors.reset}`);
        break;
      case "complete":
        logSuccess("\nAll tasks complete!");
        break;
      case "agent:stdout":
        if (event.message) process.stdout.write(event.message);
        break;
    }
  });

  // Handle Ctrl+C — await cleanup before exiting to prevent stale locks
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return; // Prevent double-cleanup on rapid signals
    cleaningUp = true;
    engine.stop();
    await endSession(plan!.paths, "interrupted");
    await updatePlanMetadata(cwd, plan!.metadata.id, { status: "paused" });
    log(`\n${colors.warning}Session interrupted. Resume with: synth resume ${plan!.metadata.id}${colors.reset}`);
  };

  process.on("SIGINT", () => { cleanup().then(() => process.exit(0)); });
  process.on("SIGTERM", () => { cleanup().then(() => process.exit(0)); });

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
    logError(`Engine error: ${err}`);
  } finally {
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
    log("This plan is already completed.");
    return;
  }

  log(`Resuming plan ${plan.metadata.id} from iteration ${session.currentIteration}`);
  await cmdRun(plan.metadata.id, session.currentIteration);
}

async function cmdPlan(planIdOrFlag?: string): Promise<void> {
  const config = await loadConfig(cwd);

  // Check if --prd flag is used
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
    log(`Created plan: ${id}`);

    // Generate tasks
    log("Generating tasks from PRD...");
    const agent = getAgent(config.agent.name);
    const taskFile = await generateTasks(
      agent,
      prdContent,
      config.project.name,
      config.project.branch,
      cwd,
    );
    await saveTasks(paths.tasks, taskFile);
    await writeText(paths.progress, "## Codebase Patterns\n\n---\n\n");
    await updatePlanMetadata(cwd, id, {
      status: "planning",
      taskCount: taskFile.tasks.length,
    });

    log(
      `Generated ${taskFile.tasks.length} tasks. Run 'synth run ${id}' to start.`,
    );
    agent.dispose();
    return;
  }

  // Show existing plan details
  if (planIdOrFlag && planIdOrFlag !== "plan") {
    const plan = await getPlan(cwd, planIdOrFlag);
    if (plan) {
      await cmdShow(planIdOrFlag);
      log(`\nTo execute: ${colors.bold}synth run ${planIdOrFlag}${colors.reset}`);
      return;
    }
  }

  // Fresh interview
  log(
    `${colors.bold}synth plan${colors.reset} — starting PRD interview\n`,
  );

  const agent = getAgent(config.agent.name);
  const detection = await agent.detect();
  if (!detection.available) {
    logError(`Agent '${config.agent.name}' not available: ${detection.error}`);
    process.exit(1);
  }

  const { id, paths } = await createPlan(cwd, "");
  const interviewer = new Interviewer(agent, cwd);

  // Start interview
  log(`${colors.magenta}Synth:${colors.reset}`);
  const opening = await interviewer.start();
  log(opening);

  // Interactive loop
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question(`\n${colors.primary}You:${colors.reset} `, resolve);
    });

  let prd = null;
  while (!prd) {
    const userInput = await askQuestion();
    if (userInput.toLowerCase() === "q" || userInput.toLowerCase() === "quit") {
      rl.close();
      agent.dispose();
      return;
    }

    log(`\n${colors.magenta}Synth:${colors.reset}`);
    const response = await interviewer.respond(userInput);
    log(response);

    prd = interviewer.extractPrd(response);
  }

  rl.close();

  // Save PRD
  const prdMarkdown = prdToMarkdown(prd);
  await writeText(paths.prd, prdMarkdown);
  await updatePlanMetadata(cwd, id, { description: prd.title });

  log(`\n${colors.success}PRD saved to ${paths.prd}${colors.reset}`);
  log("Generating tasks...\n");

  // Generate tasks
  const taskFile = await generateTasks(
    agent,
    prdMarkdown,
    config.project.name,
    config.project.branch || `synth/${id}`,
    cwd,
  );
  await saveTasks(paths.tasks, taskFile);
  await writeText(paths.progress, "## Codebase Patterns\n\n---\n\n");
  await updatePlanMetadata(cwd, id, {
    status: "planning",
    taskCount: taskFile.tasks.length,
  });

  log(`${colors.bold}Generated ${taskFile.tasks.length} tasks:${colors.reset}\n`);
  for (const task of taskFile.tasks) {
    const priorityColor = PRIORITY_COLORS[task.priority] ?? colors.muted;
    log(`  ${priorityColor}P${task.priority}${colors.reset} ${task.id} ${task.title}`);
  }

  // Prompt to start
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
      `\nPlan saved. Run later with: ${colors.bold}synth run ${id}${colors.reset}`,
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

  log(`${colors.bold}synth finalize${colors.reset} — ${plan.metadata.id}\n`);

  const agent = getAgent(config.agent.name);
  const result = await finalize(config, agent, plan.paths, cwd);
  agent.dispose();

  if (result.blocked) {
    logError(`Blocked: ${result.blockReason}`);
    process.exit(1);
  }

  if (result.findings.length > 0) {
    log(`\n${colors.bold}Review findings:${colors.reset}`);
    for (const f of result.findings) {
      const color =
        f.severity === "critical"
          ? colors.error
          : f.severity === "warning"
            ? colors.warning
            : colors.muted;
      log(`  ${color}[${f.severity}]${colors.reset} [${f.perspective}] ${f.message}`);
    }
  }

  if (result.prUrl) {
    logSuccess(`\nPR created: ${result.prUrl}`);
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
  const wtPath = join(cwd, ".worktrees", wtName);
  const branchName = `synth/${wtName}`;

  log(`Creating worktree: ${wtPath}`);

  const addHandle = spawn({
    cmd: ["git", "worktree", "add", wtPath, "-b", branchName],
    cwd,
  });
  const addResult = await addHandle.promise;
  if (addResult.exitCode !== 0) {
    logError(`Failed to create worktree: ${addResult.stderr}`);
    process.exit(1);
  }

  const cmd = doPlan ? "synth plan" : `synth run ${planId}`;
  log(`Starting: cd ${wtPath} && ${cmd}`);

  const runHandle = spawn({
    cmd: ["bash", "-c", `cd "${wtPath}" && ${cmd}`],
    cwd: wtPath,
  });

  log(`PID: ${runHandle.pid}`);
  log(`Worktree: ${wtPath}`);
  log(`Branch: ${branchName}`);
}

async function cmdPs(): Promise<void> {
  const plans = await listPlans(cwd);
  const running = plans.filter((p) => p.status === "executing");

  if (running.length === 0) {
    log("No running synth instances.");
    return;
  }

  log(`${colors.bold}Running instances:${colors.reset}\n`);
  for (const plan of running) {
    log(`  ${plan.id} — ${plan.description}`);
  }
}

async function cmdUpdate(): Promise<void> {
  log("Checking for updates...");

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!res.ok) {
    logError("Failed to check for updates");
    process.exit(1);
  }

  const release = (await res.json()) as { tag_name: string };
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

// Route commands
async function main(): Promise<void> {
  switch (command) {
    case "init":
      await cmdInit();
      break;
    case "plan":
      await cmdPlan(args[1]);
      break;
    case "run":
      await cmdRun(args[1]);
      break;
    case "resume":
      await cmdResume(args[1]);
      break;
    case "finalize":
      await cmdFinalize(args[1]);
      break;
    case "ls":
      await cmdLs();
      break;
    case "show":
      if (!args[1]) {
        logError("Usage: synth show <plan-id>");
        process.exit(1);
      }
      await cmdShow(args[1]);
      break;
    case "status":
      await cmdStatus(args[1]);
      break;
    case "config":
      await cmdConfig();
      break;
    case "spawn":
      await cmdSpawn(args[1]);
      break;
    case "ps":
      await cmdPs();
      break;
    case "update":
      await cmdUpdate();
      break;
    case "version":
    case "--version":
    case "-v":
      log(`synth ${VERSION}`);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      log(`${colors.bold}synth${colors.reset} — AI Agent Loop Orchestrator\n`);
      log("Usage: synth <command> [options]\n");
      log("Commands:");
      log("  plan [--prd <path>]    Interview → generate tasks → execute");
      log("  run [<plan-id>]        Execute the task loop");
      log("  resume [<plan-id>]     Resume paused session");
      log("  finalize [<plan-id>]   Self-review → format → split → PR");
      log("  ls                     List all plans for current repo");
      log("  show <plan-id>         Show plan details");
      log("  status [<plan-id>]     Show plan/session status");
      log("  spawn [<plan-id>]      Run plan in background worktree");
      log("  ps                     List running instances");
      log("  init                   Create synth.toml");
      log("  config                 Display configuration");
      log("  update                 Update synth to latest version");
      log("  version                Show version");
      break;
    default:
      logError(`Unknown command: ${command}`);
      log("Run 'synth help' for usage.");
      process.exit(1);
  }
}

main().catch((err) => {
  logError(String(err));
  process.exit(1);
});
