import type { TuiEngineData } from "./types.js";
import type { Task, TaskFile } from "../tasks/types.js";
import { updateTaskStatus } from "../tasks/store.js";

function buildTaskFile(tuiData: TuiEngineData): TaskFile {
  return {
    project: tuiData.projectName,
    branchName: "",
    description: "",
    tasks: tuiData.tasks,
  };
}

export function applyTaskStatus(
  tuiData: TuiEngineData,
  taskId: string,
  status: Task["status"],
  options?: { notes?: string; durationMs?: number },
): void {
  const updated = updateTaskStatus(buildTaskFile(tuiData), taskId, status, options);
  tuiData.tasks = updated.tasks;
}

export function resetTaskOutput(
  tuiData: TuiEngineData,
  taskId: string,
): void {
  tuiData.taskOutputMap[taskId] = "";
}

export function setTaskStartTime(
  tuiData: TuiEngineData,
  taskId: string,
  startTime: number,
): void {
  tuiData.taskStartTimes[taskId] = startTime;
}

export function setTaskElapsedMs(
  tuiData: TuiEngineData,
  taskId: string,
  elapsedMs: number,
): void {
  tuiData.taskElapsedMs[taskId] = elapsedMs;
}

export function addTaskElapsedMs(
  tuiData: TuiEngineData,
  taskId: string,
  elapsedMs: number,
): void {
  tuiData.taskElapsedMs[taskId] = (tuiData.taskElapsedMs[taskId] ?? 0) + elapsedMs;
}

export function appendTaskOutput(
  tuiData: TuiEngineData,
  taskId: string,
  chunk: string,
  maxLength: number,
): void {
  const prev = tuiData.taskOutputMap[taskId] ?? "";
  const next = prev + chunk;
  tuiData.taskOutputMap[taskId] = next.length > maxLength ? next.slice(-maxLength) : next;
}
