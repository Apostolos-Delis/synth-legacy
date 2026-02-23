export type RunState =
  | "running"
  | "paused"
  | "completed"
  | "interrupted"
  | "failed"
  | "blocked";

export interface RunMetadata {
  id: string;
  planId: string;
  status: RunState;
  startedAt: string;
  endedAt?: string;
  updatedAt: string;
  agent: string;
  currentIteration: number;
  maxIterations: number;
  cwd: string;
}

export interface LockFile {
  pid: number;
  runId: string;
  acquiredAt: string;
  hostname: string;
}
