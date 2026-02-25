import type { AgentToolEvent } from "../agents/types.js";

export type EngineState =
  | "idle"
  | "executing"
  | "reviewing"
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
  | "agent:tool"
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
  | "phase:streaming"
  | "ac:criteria-met";

export interface EngineEvent {
  type: EngineEventType;
  iteration?: number;
  taskId?: string;
  message?: string;
  data?: unknown;
  timestamp?: number;
  isFirstChunk?: boolean;
  criterionIndex?: number;
  tool?: AgentToolEvent;
}

export interface IterationResult {
  iteration: number;
  taskId: string;
  success: boolean;
  backpressurePassed: boolean;
  completionDetected: boolean;
  output: string;
  duration: number;
  tokenUsage?: { inputTokens: number; outputTokens: number };
}

export type EngineEventListener = (event: EngineEvent) => void;
