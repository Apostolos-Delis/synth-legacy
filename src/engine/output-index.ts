import { readText, fileExists } from "../utils/fs.js";

/**
 * Reads iteration log files for a given task and returns the concatenated output.
 * Returns empty string if no log files exist for the task.
 */
export async function loadTaskOutput(
  logsDir: string,
  taskId: string,
  iterations: { taskId: string; iteration: number }[],
): Promise<string> {
  const matching = iterations
    .filter((it) => it.taskId === taskId)
    .sort((a, b) => a.iteration - b.iteration);

  if (matching.length === 0) return "";

  const chunks = await Promise.all(
    matching.map(async (entry) => {
      const logPath = `${logsDir}/iteration-${String(entry.iteration).padStart(3, "0")}.jsonl`;
      if (await fileExists(logPath)) {
        return await readText(logPath);
      }
      return "";
    }),
  );

  return chunks.join("");
}

/**
 * Parses the progress.md file to build an iteration-to-taskId mapping.
 * Each entry looks like: ## Iteration N - TASK-ID: Title
 */
export async function buildIterationMap(
  progressPath: string,
): Promise<{ taskId: string; iteration: number }[]> {
  if (!(await fileExists(progressPath))) return [];

  const content = await readText(progressPath);
  const results: { taskId: string; iteration: number }[] = [];
  const pattern = /^## Iteration (\d+) - ([^:]+):/gm;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    results.push({
      iteration: parseInt(match[1], 10),
      taskId: match[2].trim(),
    });
  }

  return results;
}
