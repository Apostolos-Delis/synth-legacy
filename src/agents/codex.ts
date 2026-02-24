import type {
  AgentAdapter,
  AgentDetectResult,
  AgentExecuteOptions,
  AgentExecutionHandle,
  AgentExecutionResult,
} from "./types.js";
import { spawn } from "../utils/process.js";

export function buildCodexCmd(prompt: string, options: Pick<AgentExecuteOptions, "readOnly">): string[] {
  return [
    "codex",
    "--quiet",
    "--approval-mode",
    "full-auto",
    ...(options.readOnly ? ["--sandbox", "read-only"] : []),
    prompt,
  ];
}

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";
  private activeHandle: ReturnType<typeof spawn> | null = null;

  async detect(): Promise<AgentDetectResult> {
    try {
      const handle = spawn({ cmd: ["codex", "--version"] });
      const result = await handle.promise;
      if (result.exitCode === 0) {
        return { available: true, version: result.stdout.trim() };
      }
      return { available: false, error: result.stderr.trim() };
    } catch {
      return { available: false, error: "codex CLI not found" };
    }
  }

  execute(prompt: string, options: AgentExecuteOptions): AgentExecutionHandle {
    const cmd = buildCodexCmd(prompt, options);

    const handle = spawn({
      cmd,
      cwd: options.cwd,
      timeout: options.timeout,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });

    this.activeHandle = handle;

    const promise: Promise<AgentExecutionResult> = handle.promise.then(
      (result) => {
        this.activeHandle = null;
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
        };
      },
    );

    return {
      pid: handle.pid,
      promise,
      interrupt: () => handle.interrupt(),
    };
  }

  dispose(): void {
    this.activeHandle?.interrupt();
    this.activeHandle = null;
  }
}
