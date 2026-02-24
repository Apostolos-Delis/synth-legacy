import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { Task } from "../tasks/types.js";
import type { SessionPaths } from "../sessions/types.js";
import { fileExists, readText } from "../utils/fs.js";
import { globalTrace } from "../utils/perf.js";
import { loadTemplate, renderTemplate } from "../templates/index.js";
import type { TemplatePhase, TemplateVariables } from "../templates/index.js";

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

function extractCodebasePatterns(progress: string): string | undefined {
  const patternsMatch = progress.match(
    /## Codebase Patterns\n([\s\S]*?)(?=\n## (?!Codebase)|\n---|\Z)/,
  );
  return patternsMatch ? patternsMatch[1].trim() : undefined;
}

function extractRecentProgress(progress: string): string | undefined {
  const entries = progress.split("\n---\n").filter((e) => e.trim());
  const recent = entries.slice(-5).join("\n---\n");
  return recent.trim() || undefined;
}

export async function buildPrompt(
  task: Task,
  sessionPaths: SessionPaths,
  cwd: string,
  iteration: number,
  agentName?: string,
  sessionSlug?: string,
  templatePath?: string,
  phase?: TemplatePhase,
): Promise<string> {
  const trace = globalTrace();
  const sections: string[] = [];
  const agent = agentName ?? "default";

  // 1. Read AGENTS.md and progress.md concurrently (needed for template variables)
  trace.startPhase("build:read-files");
  const agentsPath = join(cwd, "AGENTS.md");
  const [agents, progress] = await Promise.all([
    cachedReadText(agentsPath),
    safeReadText(sessionPaths.progress),
  ]);
  trace.endPhase("build:read-files");

  // 2. Extract patterns and progress
  let codebasePatterns: string | undefined;
  let recentProgress: string | undefined;
  if (progress) {
    trace.startPhase("build:extract-codebase-patterns");
    codebasePatterns = extractCodebasePatterns(progress);
    trace.endPhase("build:extract-codebase-patterns");

    trace.startPhase("build:extract-recent-progress");
    recentProgress = extractRecentProgress(progress);
    trace.endPhase("build:extract-recent-progress");
  }

  // 3. Load and render the template
  trace.startPhase("build:template");
  const loadResult = await loadTemplate(agent, cwd, templatePath ? templatePath : { phase: phase ?? "execute" });
  const variables: TemplateVariables = {
    agentName: agent,
    cwd,
    currentDate: new Date().toISOString().slice(0, 10),
    slug: sessionSlug || "session-slug",
    taskId: task.id,
    taskTitle: task.title,
    taskDescription: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    priority: task.priority,
    iteration,
    projectContext: agents ?? undefined,
    codebasePatterns,
    recentProgress,
    verification: task.verification,
    notes: task.notes,
  };
  const { rendered } = renderTemplate(loadResult, variables);
  sections.push(rendered);
  trace.endPhase("build:template");

  // 4. Append contextual sections (AGENTS.md, patterns, progress)
  if (agents) {
    sections.push(`## Project Context (AGENTS.md)\n\n${agents}`);
  }

  if (codebasePatterns) {
    sections.push(
      `## Codebase Patterns (from previous iterations)\n\n${codebasePatterns}`,
    );
  }

  if (recentProgress) {
    sections.push(`## Recent Progress\n\n${recentProgress}`);
  }

  // 5. Current task
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
