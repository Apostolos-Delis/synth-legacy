import pkg from "../../package.json" assert { type: "json" };
import { loadConfig } from "../config/loader.js";
import type { SynthConfig } from "../config/types.js";
import { resolveTheme } from "../tui/themes/resolve.js";
import { ansi, fmt, STATUS_ICONS, STATUS_COLORS, initTheme } from "../tui/theme.js";
import { formatDuration } from "../utils/format.js";
import type { CompletionSummary } from "../tui/types.js";

export const VERSION = pkg.version;
export const REPO = "Apostolos-Delis/synth";

export function log(msg: string): void {
  console.log(msg);
}

export function logError(msg: string): void {
  console.error(fmt.error(msg));
}

export function logSuccess(msg: string): void {
  console.log(fmt.success(msg));
}

export async function applyTheme(cwd: string): Promise<SynthConfig> {
  const config = await loadConfig(cwd);
  const { theme, spinnerFrames } = await resolveTheme(config);
  initTheme(theme, spinnerFrames);
  return config;
}

// Heavy modules are lazy-loaded on first use to keep startup fast.

export async function loadAgentRegistry() {
  const { getAgent } = await import("../agents/registry.js");
  return { getAgent };
}

export async function loadEngine() {
  const { Engine } = await import("../engine/engine.js");
  return { Engine };
}

export async function loadRunModule() {
  const mod = await import("../run/run.js");
  return {
    createRun: mod.createRun,
    loadRun: mod.loadRun,
    acquireLock: mod.acquireLock,
    releaseLock: mod.releaseLock,
    endRun: mod.endRun,
    checkLock: mod.checkLock,
  };
}

export async function loadReviewOrchestrator() {
  const { ReviewOrchestrator } = await import("../review/orchestrator.js");
  return { ReviewOrchestrator };
}

export async function loadParallelCoordinator() {
  const { ParallelCoordinator } = await import("../parallel/coordinator.js");
  const { analyzeTaskGraph } = await import("../parallel/task-graph.js");
  return { ParallelCoordinator, analyzeTaskGraph };
}

export async function loadTui() {
  const [{ createCliRenderer }, { createRoot }, { App }, { InterviewApp }, { GeneratingView }, { ReviewView }, { FinalizeApp }, { PrdReviewView }] = await Promise.all([
    import("@opentui/core"),
    import("@opentui/react"),
    import("../tui/App.js"),
    import("../tui/InterviewApp.js"),
    import("../tui/GeneratingView.js"),
    import("../tui/ReviewView.js"),
    import("../tui/FinalizeApp.js"),
    import("../tui/PrdReviewView.js"),
  ]);
  return { createCliRenderer, createRoot, App, InterviewApp, GeneratingView, ReviewView, FinalizeApp, PrdReviewView };
}

export async function loadFinalize() {
  const { finalize } = await import("../finalize/finalize.js");
  return { finalize };
}

export async function loadInterviewer() {
  const { Interviewer, extractPrdTitle, WELCOME_MESSAGE } = await import("../interview/interviewer.js");
  return { Interviewer, extractPrdTitle, WELCOME_MESSAGE };
}

export async function loadPlanner() {
  const { generateTasks } = await import("../tasks/planner.js");
  return { generateTasks };
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

export function printCompletionSummary(data: CompletionSummary): void {
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
