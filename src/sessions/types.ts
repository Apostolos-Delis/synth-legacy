export interface SessionMetadata {
  id: string;
  repoKey: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  status: "interviewing" | "planning" | "executing" | "reviewing" | "paused" | "blocked" | "completed" | "finalizing" | "finalized" | "failed";
  taskCount: number;
  tasksCompleted: number;
  slug?: string;
  branch?: string;
  worktreePath?: string;
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
  reviewRoot: string;
  reviewFindings: string;
  reviewTasks: string;
  reviewProgress: string;
  reviewConversation: string;
}
