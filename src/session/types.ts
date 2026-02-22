export type SessionState =
  | "running"
  | "paused"
  | "completed"
  | "interrupted"
  | "failed"
  | "blocked";

export interface SessionMetadata {
  id: string;
  planId: string;
  status: SessionState;
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
  sessionId: string;
  acquiredAt: string;
  hostname: string;
}
