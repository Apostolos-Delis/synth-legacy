import type { ParallelEvent } from "../parallel/events.js";
import type { WorkerDisplayState } from "../parallel/worker.js";
import type { WorkerInfo, WorkerStatus } from "../tui/components/WorkerPanel.js";
import type { MergeQueueItem, MergeStatus } from "../tui/components/MergeQueuePanel.js";
import type { ConflictInfo, ConflictFile } from "../tui/components/ConflictResolutionPanel.js";
import type { ParallelHeaderInfo } from "../tui/components/Header.js";
import type { Task } from "../tasks/types.js";
import type { TuiEngineData } from "../tui/types.js";

export interface ParallelTuiState {
  header: ParallelHeaderInfo;
  workers: WorkerInfo[];
  mergeItems: MergeQueueItem[];
  conflict: ConflictInfo | null;
}

const WORKER_STATUS_MAP: Record<WorkerDisplayState["status"], WorkerStatus> = {
  idle: "running",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "failed",
};

export function buildWorkerInfos(displayStates: WorkerDisplayState[]): WorkerInfo[] {
  return displayStates.map((ws) => ({
    id: ws.id,
    taskTitle: ws.task.title,
    iteration: ws.currentIteration,
    maxIterations: ws.maxIterations,
    startTime: Date.now() - ws.elapsedMs,
    status: WORKER_STATUS_MAP[ws.status] ?? "running",
    lastOutput: ws.lastOutput,
    branchName: ws.branchName,
    lastCommitSha: "",
  }));
}

export function createInitialTuiState(totalTasks: number): ParallelTuiState {
  return {
    header: {
      currentWave: 1,
      totalWaves: 1,
      activeWorkers: 0,
      mergedTasks: 0,
      totalTasks,
    },
    workers: [],
    mergeItems: [],
    conflict: null,
  };
}

export function applyParallelEvent(
  event: ParallelEvent,
  state: ParallelTuiState,
  getWorkerDisplayStates?: () => WorkerDisplayState[],
): boolean {
  switch (event.type) {
    case "parallel:started":
      return true;

    case "parallel:group-started":
      state.header.currentWave++;
      return true;

    case "worker:created":
    case "worker:started":
      if (getWorkerDisplayStates) {
        state.workers = buildWorkerInfos(getWorkerDisplayStates());
      }
      state.header.activeWorkers = state.workers.filter(
        (w) => w.status === "running",
      ).length;
      return true;

    case "worker:progress":
    case "worker:output":
      if (getWorkerDisplayStates) {
        state.workers = buildWorkerInfos(getWorkerDisplayStates());
      }
      return true;

    case "worker:completed":
    case "worker:failed":
      if (getWorkerDisplayStates) {
        state.workers = buildWorkerInfos(getWorkerDisplayStates());
      }
      state.header.activeWorkers = state.workers.filter(
        (w) => w.status === "running",
      ).length;
      return true;

    case "merge:queued":
      state.mergeItems.push({
        id: event.operationId,
        taskId: event.taskId,
        status: "queued" as MergeStatus,
        strategy: "squash",
        filesChanged: 0,
        queuePosition: state.mergeItems.length,
      });
      return true;

    case "merge:started": {
      const item = state.mergeItems.find((m) => m.id === event.operationId);
      if (item) {
        item.status = "in-progress";
        item.startTime = Date.now();
      }
      return true;
    }

    case "merge:completed": {
      const item = state.mergeItems.find((m) => m.id === event.operationId);
      if (item) {
        item.status = "completed";
        item.endTime = Date.now();
      }
      state.header.mergedTasks = state.mergeItems.filter(
        (m) => m.status === "completed",
      ).length;
      return true;
    }

    case "merge:failed": {
      const item = state.mergeItems.find((m) => m.id === event.operationId);
      if (item) {
        item.status = "failed";
        item.endTime = Date.now();
        item.error = event.reason;
      }
      return true;
    }

    case "merge:skipped":
      state.mergeItems.push({
        id: `skip-${event.taskId}`,
        taskId: event.taskId,
        status: "skipped",
        strategy: "squash",
        filesChanged: 0,
        queuePosition: state.mergeItems.length,
        endTime: Date.now(),
        error: event.reason,
      });
      return true;

    case "conflict:detected":
      state.conflict = {
        taskId: event.taskId,
        taskTitle: event.taskTitle,
        files: event.files.map(
          (f): ConflictFile => ({ path: f, status: "pending" }),
        ),
        summary: null,
      };
      return true;

    case "conflict:ai-resolving":
      if (state.conflict && event.filePath) {
        const file = state.conflict.files.find(
          (f) => f.path === event.filePath,
        );
        if (file) file.status = "ai-resolving";
      }
      return true;

    case "conflict:resolved":
      if (state.conflict) {
        state.conflict.summary = {
          resolved: event.resolvedCount,
          failed: event.failedCount,
        };
        for (const file of state.conflict.files) {
          if (file.status === "ai-resolving" || file.status === "pending") {
            file.status = "resolved";
          }
        }
      }
      state.conflict = null;
      return true;

    case "throttle:active":
      return true;

    case "parallel:completed":
    case "parallel:failed":
      state.header.activeWorkers = 0;
      return true;

    default:
      return false;
  }
}

export function buildFixTuiData(
  tasks: Task[],
  config: { agent: { name: string }; project: { name: string } },
  sessionId: string,
  phase?: string,
): TuiEngineData {
  return {
    engineState: "executing",
    iteration: 0,
    maxIterations: 1,
    tasks,
    currentTaskId: null,
    output: "",
    agentName: config.agent.name,
    projectName: config.project.name,
    sessionId,
    startTime: Date.now(),
    interviewMessages: [],
    isThinking: false,
    currentPhase: phase ?? "Fix execution",
    phaseStartTime: Date.now(),
    completionSummary: null,
    taskOutputMap: {},
    taskElapsedMs: {},
    taskStartTimes: {},
    iterationEntries: [],
    configDisplay: "",
    tokenUsage: { sessionTotal: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, taskTotals: {}, hasData: false },
  };
}
