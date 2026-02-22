import type { Task, TaskFile } from "./types.js";
import { readJson, writeJson } from "../utils/fs.js";

export async function loadTasks(path: string): Promise<TaskFile> {
  return readJson<TaskFile>(path);
}

export async function saveTasks(
  path: string,
  taskFile: TaskFile,
): Promise<void> {
  await writeJson(path, taskFile);
}

export function updateTaskStatus(
  taskFile: TaskFile,
  taskId: string,
  status: Task["status"],
  notes?: string,
): TaskFile {
  return {
    ...taskFile,
    tasks: taskFile.tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            status,
            notes: notes ? (t.notes ? `${t.notes}\n${notes}` : notes) : t.notes,
            iterationCount:
              status === "in_progress" ? t.iterationCount + 1 : t.iterationCount,
          }
        : t,
    ),
  };
}

export function getTaskById(
  taskFile: TaskFile,
  taskId: string,
): Task | undefined {
  return taskFile.tasks.find((t) => t.id === taskId);
}

export function allTasksDone(taskFile: TaskFile): boolean {
  return taskFile.tasks.every(
    (t) => t.status === "done" || t.status === "skipped",
  );
}

export function resetOrphanedTasks(taskFile: TaskFile): TaskFile {
  const hasOrphans = taskFile.tasks.some((t) => t.status === "in_progress");
  if (!hasOrphans) return taskFile;

  return {
    ...taskFile,
    tasks: taskFile.tasks.map((t) =>
      t.status === "in_progress"
        ? { ...t, status: "open" as const, notes: t.notes ? `${t.notes}\nReset from in_progress (orphaned by crashed session)` : "Reset from in_progress (orphaned by crashed session)" }
        : t,
    ),
  };
}

export function getProgress(taskFile: TaskFile): {
  total: number;
  done: number;
  failed: number;
  open: number;
  inProgress: number;
} {
  const tasks = taskFile.tasks;
  return {
    total: tasks.length,
    done: tasks.filter((t) => t.status === "done").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    open: tasks.filter((t) => t.status === "open").length,
    inProgress: tasks.filter((t) => t.status === "in_progress").length,
  };
}
