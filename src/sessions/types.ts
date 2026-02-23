export interface SessionMetadata {
  id: string;
  repoKey: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  status: "interviewing" | "planning" | "executing" | "paused" | "blocked" | "completed" | "finalizing" | "finalized" | "failed";
  taskCount: number;
  tasksCompleted: number;
  slug?: string;
}

export interface SessionPaths {
  root: string;
  prd: string;
  tasks: string;
  progress: string;
  run: string;
  lock: string;
  logs: string;
  summary: string;
  interview: string;
}
