import type { EngineEvent } from "../engine/types.js";
import type { ParallelEvent } from "../parallel/events.js";
import type { CompletionSummary } from "../tui/types.js";
import type { Task } from "../tasks/types.js";
import type { SynthConfig } from "../config/types.js";
import type { SessionPaths } from "../sessions/types.js";

// ---------------------------------------------------------------------------
// PipelinePhase
// ---------------------------------------------------------------------------

export type PipelinePhase =
  | "initializing"
  | "executing"
  | "reviewing"
  | "summarizing"
  | "awaiting-action"
  | "finalizing"
  | "done"
  | "failed";

// ---------------------------------------------------------------------------
// PipelineEvent — discriminated union on `type`
// ---------------------------------------------------------------------------

export interface PhaseChangedEvent {
  type: "phase:changed";
  phase: PipelinePhase;
  previousPhase: PipelinePhase | null;
}

export interface EngineForwardedEvent {
  type: "engine:event";
  event: EngineEvent;
}

export interface ParallelForwardedEvent {
  type: "parallel:event";
  event: ParallelEvent;
}

export interface TaskStatusChangedEvent {
  type: "task:status-changed";
  taskId: string;
  status: Task["status"];
  task: Task;
}

export interface SummaryReadyEvent {
  type: "summary:ready";
  summary: CompletionSummary;
}

export interface ReviewStatusChangedEvent {
  type: "review:status-changed";
  status: "running" | "ready" | "complete" | "error";
  error?: string;
}

export interface ExecutionCompletedEvent {
  type: "execution:completed";
  success: boolean;
}

export interface PipelineErrorEvent {
  type: "error";
  error: Error;
  phase: PipelinePhase;
}

export interface PipelineLogEvent {
  type: "log";
  level: "info" | "warn" | "error" | "debug";
  message: string;
}

export type PipelineEvent =
  | PhaseChangedEvent
  | EngineForwardedEvent
  | ParallelForwardedEvent
  | TaskStatusChangedEvent
  | SummaryReadyEvent
  | ReviewStatusChangedEvent
  | ExecutionCompletedEvent
  | PipelineErrorEvent
  | PipelineLogEvent;

// ---------------------------------------------------------------------------
// PipelineOptions — everything cmdRun currently extracts from CliContext + config
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  cwd: string;
  sessionId: string;
  sessionPaths: SessionPaths;
  config: SynthConfig;
  startIteration: number;
  parallelMode: boolean;
  parallelWorkers: number | undefined;
  tuiEnabled: boolean;
}

// ---------------------------------------------------------------------------
// PipelineState
// ---------------------------------------------------------------------------

export interface PipelineState {
  phase: PipelinePhase;
  tasks: Task[];
  currentTaskId: string | null;
  iteration: number;
  summary: CompletionSummary | null;
  error: Error | null;
}

// ---------------------------------------------------------------------------
// ActionRequest / UserAction — for the awaiting-action phase
// ---------------------------------------------------------------------------

export interface ActionRequest {
  id: string;
  prompt: string;
  options: UserActionOption[];
}

export interface UserActionOption {
  key: string;
  label: string;
}

export interface UserAction {
  requestId: string;
  key: string;
}

// ---------------------------------------------------------------------------
// PipelineEmitter — public surface of the pipeline
// ---------------------------------------------------------------------------

export type PipelineEventListener = (event: PipelineEvent) => void;

export interface PipelineEmitter {
  on(listener: PipelineEventListener): () => void;
  run(): Promise<void>;
  stop(): void;
  getState(): PipelineState;
  submitAction(action: UserAction): void;
}
