import type { Task, TaskFile } from "./types.js";

export function selectNextTask(taskFile: TaskFile): Task | null {
  const doneTasks = new Set(
    taskFile.tasks.filter((t) => t.status === "done" || t.status === "skipped").map((t) => t.id),
  );

  const candidates = taskFile.tasks.filter((t) => {
    if (t.status !== "open") return false;

    // Check all dependencies are satisfied
    if (t.dependsOn?.length) {
      return t.dependsOn.every((dep) => doneTasks.has(dep));
    }
    return true;
  });

  if (candidates.length === 0) return null;

  // Sort by priority (1 = highest), then by ID for stability
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.id.localeCompare(b.id);
  });

  return candidates[0];
}
