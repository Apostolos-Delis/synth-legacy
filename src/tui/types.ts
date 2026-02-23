import type { Task } from "../tasks/types.js";
import type { EngineState } from "../engine/types.js";
import type { InterviewMessage } from "../interview/types.js";

export type ViewMode = "execution" | "dashboard" | "interview" | "generating" | "review" | "completion" | "completion-finalize";
export type NavMode = "task-scroll" | "output-scroll";

export interface TuiContext {
  renderer: Awaited<ReturnType<typeof import("@opentui/core")["createCliRenderer"]>>;
  root: ReturnType<typeof import("@opentui/react")["createRoot"]>;
}

export interface CompletionSummary {
  projectName: string;
  planId: string;
  agentName: string;
  totalDurationMs: number;
  totalIterations: number;
  tasks: Task[];
  progress: { total: number; done: number; failed: number; open: number; inProgress: number };
  commits: string[];
  summaryFilePath: string;
}

export interface TuiEngineData {
  engineState: EngineState;
  iteration: number;
  maxIterations: number;
  tasks: Task[];
  currentTaskId: string | null;
  output: string;
  agentName: string;
  projectName: string;
  planId: string;
  startTime: number;
  interviewMessages: InterviewMessage[];
  isThinking: boolean;
  currentPhase: string | null;
  phaseStartTime: number | null;
  completionSummary: CompletionSummary | null;
  taskOutputMap: Record<string, string>;
}

export interface TuiState extends TuiEngineData {
  view: ViewMode;
}
