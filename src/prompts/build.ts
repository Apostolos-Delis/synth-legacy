import { join } from "node:path";
import type { Task } from "../tasks/types.js";
import type { PlanPaths } from "../plans/types.js";
import { ITERATION_INSTRUCTIONS } from "./instructions.js";
import { fileExists, readText } from "../utils/fs.js";

export async function buildPrompt(
  task: Task,
  planPaths: PlanPaths,
  cwd: string,
  iteration: number,
): Promise<string> {
  const sections: string[] = [];

  // 1. Instructions
  sections.push(ITERATION_INSTRUCTIONS);

  // 2. AGENTS.md (project-level context)
  const agentsPath = join(cwd, "AGENTS.md");
  if (await fileExists(agentsPath)) {
    const agents = await readText(agentsPath);
    sections.push(`## Project Context (AGENTS.md)\n\n${agents}`);
  }

  // 3. Codebase patterns (top of progress.md)
  if (await fileExists(planPaths.progress)) {
    const progress = await readText(planPaths.progress);
    const patternsMatch = progress.match(
      /## Codebase Patterns\n([\s\S]*?)(?=\n## (?!Codebase)|\n---|\Z)/,
    );
    if (patternsMatch) {
      sections.push(
        `## Codebase Patterns (from previous iterations)\n\n${patternsMatch[1].trim()}`,
      );
    }

    // Recent progress (last 5 entries)
    const entries = progress.split("\n---\n").filter((e) => e.trim());
    const recent = entries.slice(-5).join("\n---\n");
    if (recent.trim()) {
      sections.push(`## Recent Progress\n\n${recent}`);
    }
  }

  // 4. Current task
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

  return sections.join("\n\n---\n\n");
}
