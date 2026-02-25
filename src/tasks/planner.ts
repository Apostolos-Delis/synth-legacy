import type { TaskFile } from "./types.js";
import type { AgentAdapter, AgentToolEvent } from "../agents/types.js";
import { readText, fileExists } from "../utils/fs.js";
import { loadTemplate, renderTemplate } from "../templates/index.js";
import type { TemplateVariables } from "../templates/index.js";

export interface GenerateTasksOptions {
  model?: string;
  taskPrefix?: string;
  onProgress?: (chunk: string) => void;
  onTool?: (event: AgentToolEvent) => void;
}

export async function generateTasks(
  agent: AgentAdapter,
  prdPath: string,
  projectName: string,
  branchName: string,
  cwd: string,
  options?: GenerateTasksOptions,
): Promise<TaskFile> {
  const { model, taskPrefix, onProgress, onTool } = options ?? {};
  if (!(await fileExists(prdPath))) {
    throw new Error(`PRD file not found: ${prdPath}. Run 'synth start' to generate one.`);
  }
  const prd = await readText(prdPath);

  const templateResult = await loadTemplate(agent.name, cwd, { phase: "plan" });
  const rendered = renderTemplate(templateResult, {
    agentName: agent.name,
    cwd,
    currentDate: new Date().toISOString().slice(0, 10),
    slug: "",
    taskId: "",
    taskTitle: "",
    taskDescription: "",
    acceptanceCriteria: [],
    priority: 0,
    iteration: 0,
    taskPrefix: taskPrefix ?? "US",
  } as TemplateVariables & { taskPrefix: string });

  const prompt = `${rendered.rendered}

Project: ${projectName}
Branch: ${branchName}

PRD:
${prd}`;

  const handle = agent.execute(prompt, {
    cwd,
    model,
    readOnly: true,
    skipPermissions: false,
    onStdout: (chunk) => {
      onProgress?.(chunk);
    },
    onTool: (event) => {
      onTool?.(event);
    },
  });
  const result = await handle.promise;
  const output = result.stdout;
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
    affects: t.affects ?? [],
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
