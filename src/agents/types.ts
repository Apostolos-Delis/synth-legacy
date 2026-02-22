export interface AgentDetectResult {
  available: boolean;
  version?: string;
  error?: string;
}

export interface AgentExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  firstTokenMs?: number | null;
}

export interface AgentExecuteOptions {
  cwd: string;
  timeout?: number;
  model?: string;
  skipPermissions?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface AgentExecutionHandle {
  pid: number;
  promise: Promise<AgentExecutionResult>;
  interrupt(): void;
}

export interface AgentAdapter {
  readonly name: string;
  detect(): Promise<AgentDetectResult>;
  execute(prompt: string, options: AgentExecuteOptions): AgentExecutionHandle;
  dispose(): void;
}
