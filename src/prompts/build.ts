import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { Task } from "../tasks/types.js";
import type { PlanPaths } from "../plans/types.js";
import { ITERATION_INSTRUCTIONS } from "./instructions.js";
import { fileExists, readText } from "../utils/fs.js";
import { globalTrace } from "../utils/perf.js";

interface CacheEntry {
  content: string;
  mtimeMs: number;
}

const fileCache = new Map<string, CacheEntry>();

async function cachedReadText(path: string): Promise<string | null> {
  try {
    const st = await stat(path);
    const cached = fileCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      return cached.content;
    }
    const content = await readText(path);
    fileCache.set(path, { content, mtimeMs: st.mtimeMs });
    return content;
  } catch {
    return null;
  }
}

async function safeReadText(path: string): Promise<string | null> {
  if (await fileExists(path)) {
    return await readText(path);
  }
  return null;
}

function getAgentSpecificInstructions(agentName: string): string | null {
  switch (agentName) {
    case "claude":
      return `## Agent-Specific Guidance (Claude)

- Use the Task tool with subagent_type to delegate independent sub-tasks in parallel
- Prefer Glob/Grep/Read over Bash for file operations — dedicated tools give better output
- When exploring unfamiliar code, use the Explore agent rather than manual grep chains
- For multi-file changes, use parallel tool calls when edits are independent
- Mark ac-done markers immediately after completing each acceptance criterion`;

    case "codex":
      return `## Agent-Specific Guidance (Codex)

- Use the apply patch tool for multi-line edits — it handles conflict resolution automatically
- Prefer structured tool output over shell pipelines for file reads and searches
- When running verification commands, chain them with && to fail fast on first error
- Keep shell commands simple and atomic — avoid complex piped expressions
- Write file contents directly rather than using echo/cat with heredocs`;

    default:
      return null;
  }
}

export async function buildPrompt(
  task: Task,
  planPaths: PlanPaths,
  cwd: string,
  iteration: number,
  agentName?: string,
): Promise<string> {
  const trace = globalTrace();
  const sections: string[] = [];

  // 1. Instructions
  sections.push(ITERATION_INSTRUCTIONS);

  // 1b. Agent-specific instructions (injected after generic instructions)
  if (agentName) {
    const agentInstructions = getAgentSpecificInstructions(agentName);
    if (agentInstructions) {
      sections.push(agentInstructions);
    }
  }

  // 2 & 3. Read AGENTS.md and progress.md concurrently
  trace.startPhase("build:read-files");
  const agentsPath = join(cwd, "AGENTS.md");
  const [agents, progress] = await Promise.all([
    cachedReadText(agentsPath),
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
${task.acceptanceCriteria.map((c, i) => `- [ ] #${i + 1}: ${c}`).join("\n")}
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
