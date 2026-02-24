import type { TaskFile } from "./types.js";
import type { AgentAdapter } from "../agents/types.js";
import { readText, fileExists } from "../utils/fs.js";

function buildPlannerPrompt(taskPrefix: string): string {
  return `You are a task planner. Given a PRD (Product Requirements Document), generate a structured task list.

Output ONLY a JSON object with this exact structure (no markdown fences, no explanation):

{
  "project": "<project name>",
  "branchName": "<branch name>",
  "description": "<brief description>",
  "tasks": [
    {
      "id": "${taskPrefix}-001",
      "title": "<task title>",
      "description": "<what to implement>",
      "acceptanceCriteria": ["<criterion 1>", "<criterion 2>"],
      "verification": [{"type": "command", "value": "bun run typecheck"}],
      "priority": 1,
      "status": "open",
      "dependsOn": [],
      "notes": "",
      "iterationCount": 0
    }
  ]
}

Rules:
- IDs follow the pattern ${taskPrefix}-001, ${taskPrefix}-002, etc.
- Priority 1 = highest (do first), 5 = lowest
- Set dependsOn to IDs of tasks that must complete first
- Each task should be completable in one agent iteration (~10 min)
- Include verification commands when possible (typecheck, lint, test)
- Keep tasks focused: one logical change per task
- Order by dependency chain, then priority`;
}

export interface GenerateTasksOptions {
  model?: string;
  taskPrefix?: string;
  onProgress?: (chunk: string) => void;
}

export async function generateTasks(
  agent: AgentAdapter,
  prdPath: string,
  projectName: string,
  branchName: string,
  cwd: string,
  options?: GenerateTasksOptions,
): Promise<TaskFile> {
  const { model, taskPrefix, onProgress } = options ?? {};
  if (!(await fileExists(prdPath))) {
    throw new Error(`PRD file not found: ${prdPath}. Run 'synth start' to generate one.`);
  }
  const prd = await readText(prdPath);
  const prompt = `${buildPlannerPrompt(taskPrefix ?? "US")}

Project: ${projectName}
Branch: ${branchName}

PRD:
${prd}`;

  let output = "";
  const handle = agent.execute(prompt, {
    cwd,
    model,
    readOnly: true,
    skipPermissions: false,
    onStdout: (chunk) => {
      output += chunk;
      onProgress?.(chunk);
    },
  });
  const result = await handle.promise;
  if (result.timedOut) {
    throw new Error("Planner agent timed out");
  }
  if (result.exitCode !== 0) {
    throw new Error(`Planner agent exited with code ${result.exitCode}: ${result.stderr}`);
  }

  const taskFile = extractAndValidateTaskFile(output);

  // Ensure all tasks have required defaults
  taskFile.tasks = taskFile.tasks.map((t) => ({
    ...t,
    status: t.status ?? "open",
    iterationCount: t.iterationCount ?? 0,
    notes: t.notes ?? "",
  }));

  return taskFile;
}

function extractAndValidateTaskFile(output: string): TaskFile {
  // Try fenced JSON block first (```json ... ```)
  const fencedMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (fencedMatch) {
    const parsed = tryParseTaskFile(fencedMatch[1]);
    if (parsed) return parsed;
  }

  // Try finding all JSON objects and use the last valid one
  const jsonBlocks = output.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  if (jsonBlocks) {
    for (let i = jsonBlocks.length - 1; i >= 0; i--) {
      const parsed = tryParseTaskFile(jsonBlocks[i]);
      if (parsed) return parsed;
    }
  }

  // Fallback: greedy match
  const greedyMatch = output.match(/\{[\s\S]*\}/);
  if (greedyMatch) {
    const parsed = tryParseTaskFile(greedyMatch[0]);
    if (parsed) return parsed;
  }

  throw new Error("Failed to extract valid task JSON from agent output. Expected an object with 'tasks' array.");
}

function tryParseTaskFile(raw: string): TaskFile | null {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    if (!Array.isArray(obj.tasks)) return null;
    // Validate at least first task has required fields
    if (obj.tasks.length > 0) {
      const first = obj.tasks[0];
      if (!first.id || !first.title) return null;
    }
    return obj as TaskFile;
  } catch {
    return null;
  }
}
