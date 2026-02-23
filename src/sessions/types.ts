export interface SessionMetadata {
  id: string;
  repoKey: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  status: "interviewing" | "planning" | "executing" | "paused" | "blocked" | "completed" | "finalized" | "failed";
  taskCount: number;
  tasksCompleted: number;
}

export interface SessionPaths {
  root: string;
  prd: string;
  tasks: string;
  progress: string;
  session: string;
  lock: string;
  logs: string;
  summary: string;
  interview: string;
}
