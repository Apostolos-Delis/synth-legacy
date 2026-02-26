import type { TaskFile } from "./types.js";
import type { AgentAdapter, AgentToolEvent } from "../agents/types.js";
import { readText, fileExists } from "../utils/fs.js";
import { loadTemplate, renderTemplate } from "../templates/index.js";
import type { TemplateVariables } from "../templates/index.js";
import { getLogger } from "../logging/logger.js";

const TOOL_INPUT_LIMIT = 600;
const TOOL_OUTPUT_LIMIT = 1200;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

function toDisplay(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

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
  const logger = getLogger();
  const startedAt = Date.now();
  let toolUseCount = 0;
  let toolResultCount = 0;

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

  logger.info("planner:request", "Planner request started", {
    project: projectName,
    branch: branchName,
    prdLength: prd.length,
    model,
    taskPrefix: taskPrefix ?? "US",
  });

  const handle = agent.execute(prompt, {
    cwd,
    model,
    readOnly: true,
    skipPermissions: false,
    onStdout: (chunk) => {
      onProgress?.(chunk);
    },
    onTool: (event) => {
      if (event.kind === "use") toolUseCount += 1;
      if (event.kind === "result") toolResultCount += 1;
      const input = event.input !== undefined ? truncate(toDisplay(event.input), TOOL_INPUT_LIMIT) : undefined;
      const output = event.output !== undefined ? truncate(toDisplay(event.output), TOOL_OUTPUT_LIMIT) : undefined;
      logger.debug("planner:tool", "Planner tool event", {
        kind: event.kind,
        name: event.name,
        id: event.id,
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
      });
      onTool?.(event);
    },
  });
  const result = await handle.promise;
  const durationMs = Date.now() - startedAt;
  logger.info("planner:response", "Planner response complete", {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs,
    stdoutLength: result.stdout.length,
    stderrLength: result.stderr.length,
    toolUseCount,
    toolResultCount,
  });
  const output = result.stdout;
  if (result.timedOut) {
    logger.error("planner:timeout", "Planner agent timed out", { durationMs });
    throw new Error("Planner agent timed out");
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr ? truncate(result.stderr, 2000) : "";
    logger.error("planner:exit", "Planner agent exited non-zero", {
      exitCode: result.exitCode,
      stderr,
    });
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
