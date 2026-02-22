import type { Task } from "../tasks/types.js";
import type { EngineState } from "../engine/types.js";
import type { InterviewMessage } from "../interview/types.js";

export type ViewMode = "execution" | "dashboard" | "interview";

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
}

export interface TuiState extends TuiEngineData {
  view: ViewMode;
}
