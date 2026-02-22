export type EngineState =
  | "idle"
  | "executing"
  | "paused"
  | "blocked"
  | "completed"
  | "failed";

export type EngineEventType =
  | "iteration:start"
  | "iteration:end"
  | "task:start"
  | "task:complete"
  | "task:failed"
  | "agent:stdout"
  | "agent:stderr"
  | "backpressure:start"
  | "backpressure:pass"
  | "backpressure:fail"
  | "circuit:trip"
  | "rate-limit:detected"
  | "state:change"
  | "complete"
  | "phase:scanning"
  | "phase:building-prompt"
  | "phase:spawning-agent"
  | "phase:waiting-response"
  | "phase:streaming";

export interface EngineEvent {
  type: EngineEventType;
  iteration?: number;
  taskId?: string;
  message?: string;
  data?: unknown;
  timestamp?: number;
}

export interface IterationResult {
  iteration: number;
  taskId: string;
  success: boolean;
  backpressurePassed: boolean;
  completionDetected: boolean;
  output: string;
  duration: number;
}

export type EngineEventListener = (event: EngineEvent) => void;
