import type {
  AgentAdapter,
  AgentDetectResult,
  AgentExecuteOptions,
  AgentExecutionHandle,
  AgentExecutionResult,
} from "./types.js";
import { spawn } from "../utils/process.js";

export class ClaudeAdapter implements AgentAdapter {
  readonly name = "claude";
  private activeHandle: ReturnType<typeof spawn> | null = null;

  async detect(): Promise<AgentDetectResult> {
    try {
      const handle = spawn({ cmd: ["claude", "--version"] });
      const result = await handle.promise;
      if (result.exitCode === 0) {
        return { available: true, version: result.stdout.trim() };
      }
      return { available: false, error: result.stderr.trim() };
    } catch {
      return { available: false, error: "claude CLI not found" };
    }
  }

  execute(prompt: string, options: AgentExecuteOptions): AgentExecutionHandle {
    const cmd = [
      "claude",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      ...(options.model ? ["--model", options.model] : []),
      ...(options.skipPermissions !== false ? ["--dangerously-skip-permissions"] : []),
    ];

    const handle = spawn({
      cmd,
      cwd: options.cwd,
      timeout: options.timeout,
      onStdout: (chunk) => {
        // Parse stream-json format: each line is a JSON object
        const lines = chunk.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            // Extract text content from assistant messages
            if (msg.type === "assistant" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "text" && block.text) {
                  options.onStdout?.(block.text);
                }
              }
            } else if (msg.type === "result" && msg.result) {
              options.onStdout?.(msg.result);
            }
          } catch {
            // Not JSON or unexpected format — pass through raw
            options.onStdout?.(line);
          }
        }
      },
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
