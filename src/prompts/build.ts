import { join } from "node:path";
import type { Task } from "../tasks/types.js";
import type { PlanPaths } from "../plans/types.js";
import { ITERATION_INSTRUCTIONS } from "./instructions.js";
import { fileExists, readText } from "../utils/fs.js";
import { globalTrace } from "../utils/perf.js";

async function safeReadText(path: string): Promise<string | null> {
  if (await fileExists(path)) {
    return await readText(path);
  }
  return null;
}

export async function buildPrompt(
  task: Task,
  planPaths: PlanPaths,
  cwd: string,
  iteration: number,
): Promise<string> {
  const trace = globalTrace();
  const sections: string[] = [];

  // 1. Instructions
  sections.push(ITERATION_INSTRUCTIONS);

  // 2 & 3. Read AGENTS.md and progress.md concurrently
  trace.startPhase("build:read-files");
  const agentsPath = join(cwd, "AGENTS.md");
  const [agents, progress] = await Promise.all([
    safeReadText(agentsPath),
    safeReadText(planPaths.progress),
  ]);
  trace.endPhase("build:read-files");

  if (agents) {
    sections.push(`## Project Context (AGENTS.md)\n\n${agents}`);
  }

  if (progress) {
    trace.startPhase("build:extract-codebase-patterns");
    const patternsMatch = progress.match(
      /## Codebase Patterns\n([\s\S]*?)(?=\n## (?!Codebase)|\n---|\Z)/,
    );
    if (patternsMatch) {
      sections.push(
        `## Codebase Patterns (from previous iterations)\n\n${patternsMatch[1].trim()}`,
      );
    }
    trace.endPhase("build:extract-codebase-patterns");

    // Recent progress (last 5 entries)
    trace.startPhase("build:extract-recent-progress");
    const entries = progress.split("\n---\n").filter((e) => e.trim());
    const recent = entries.slice(-5).join("\n---\n");
    if (recent.trim()) {
      sections.push(`## Recent Progress\n\n${recent}`);
    }
    trace.endPhase("build:extract-recent-progress");
  }

  // 4. Current task
  trace.startPhase("build:assemble-prompt");
  sections.push(`## Current Task (Iteration ${iteration})

**ID**: ${task.id}
**Title**: ${task.title}
**Priority**: ${task.priority}
**Description**: ${task.description}

### Acceptance Criteria
${task.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}
${
  task.verification?.length
    ? `\n### Verification Commands\n${task.verification.map((v) => `- \`${v.value}\``).join("\n")}`
    : ""
}
${task.notes ? `\n### Notes from Previous Attempts\n${task.notes}` : ""}`);

  const result = sections.join("\n\n---\n\n");
  trace.endPhase("build:assemble-prompt");

  return result;
}
