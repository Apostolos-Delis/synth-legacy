// Worker events

export interface WorkerCreatedEvent {
  type: "worker:created";
  timestamp: string;
  workerId: string;
}

export interface WorkerStartedEvent {
  type: "worker:started";
  timestamp: string;
  workerId: string;
}

export interface WorkerCompletedEvent {
  type: "worker:completed";
  timestamp: string;
  workerId: string;
}

export interface WorkerFailedEvent {
  type: "worker:failed";
  timestamp: string;
  workerId: string;
}

export interface WorkerProgressEvent {
  type: "worker:progress";
  timestamp: string;
  workerId: string;
  iteration: number;
  maxIterations: number;
  elapsedMs: number;
  status: string;
}

export interface WorkerOutputEvent {
  type: "worker:output";
  timestamp: string;
  workerId: string;
  message: string;
  taskId: string;
}

// Merge events

export interface MergeQueuedEvent {
  type: "merge:queued";
  timestamp: string;
  operationId: string;
  taskId: string;
}

export interface MergeStartedEvent {
  type: "merge:started";
  timestamp: string;
  operationId: string;
  taskId: string;
}

export interface MergeCompletedEvent {
  type: "merge:completed";
  timestamp: string;
  operationId: string;
  taskId: string;
}

export interface MergeFailedEvent {
  type: "merge:failed";
  timestamp: string;
  operationId: string;
  taskId: string;
  reason?: string;
}

export interface MergeSkippedEvent {
  type: "merge:skipped";
  timestamp: string;
  taskId: string;
  reason: string;
}

// Conflict events

export interface ConflictDetectedEvent {
  type: "conflict:detected";
  timestamp: string;
  taskId: string;
  taskTitle: string;
  files: string[];
}

export interface ConflictAiResolvingEvent {
  type: "conflict:ai-resolving";
  timestamp: string;
  taskId: string;
  filePath?: string;
}

export interface ConflictResolvedEvent {
  type: "conflict:resolved";
  timestamp: string;
  taskId: string;
  resolvedCount: number;
  failedCount: number;
}

// Re-queue events

export interface TaskRequeuedEvent {
  type: "task:requeued";
  timestamp: string;
  taskId: string;
  attempt: number;
  maxAttempts: number;
}

// Throttle events

export interface ThrottleActiveEvent {
  type: "throttle:active";
  timestamp: string;
  recommendedConcurrency: number;
  maxConcurrency: number;
  reason: string;
}

// Session-level events

export interface ParallelStartedEvent {
  type: "parallel:started";
  timestamp: string;
}

export interface ParallelGroupStartedEvent {
  type: "parallel:group-started";
  timestamp: string;
}

export interface ParallelGroupCompletedEvent {
  type: "parallel:group-completed";
  timestamp: string;
}

export interface ParallelCompletedEvent {
  type: "parallel:completed";
  timestamp: string;
}

export interface ParallelWarningEvent {
  type: "parallel:warning";
  timestamp: string;
  message: string;
}

export interface ParallelFailedEvent {
  type: "parallel:failed";
  timestamp: string;
  reason?: string;
}

export type ParallelEvent =
  | WorkerCreatedEvent
  | WorkerStartedEvent
  | WorkerCompletedEvent
  | WorkerFailedEvent
  | WorkerProgressEvent
  | WorkerOutputEvent
  | MergeQueuedEvent
  | MergeStartedEvent
  | MergeCompletedEvent
  | MergeFailedEvent
  | MergeSkippedEvent
  | ConflictDetectedEvent
  | ConflictAiResolvingEvent
  | ConflictResolvedEvent
  | TaskRequeuedEvent
  | ThrottleActiveEvent
  | ParallelStartedEvent
  | ParallelGroupStartedEvent
  | ParallelGroupCompletedEvent
  | ParallelCompletedEvent
  | ParallelWarningEvent
  | ParallelFailedEvent;

export type ParallelEventListener = (event: ParallelEvent) => void;
