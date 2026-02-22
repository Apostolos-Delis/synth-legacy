import type {
  AgentAdapter,
  AgentDetectResult,
  AgentExecuteOptions,
  AgentExecutionHandle,
  AgentExecutionResult,
} from "./types.js";
import { spawn } from "../utils/process.js";
import { globalTrace } from "../utils/perf.js";

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
    const trace = globalTrace();

    // Use plain text print mode (like ralph-tui's default).
    // stream-json requires --verbose and complex JSONL parsing; plain text
    // streams raw output directly which is simpler and more reliable.
    const cmd = [
      "claude",
      "-p",
      prompt,
      ...(options.model ? ["--model", options.model] : []),
      ...(options.skipPermissions !== false ? ["--dangerously-skip-permissions"] : []),
    ];

    trace.startPhase("agent:spawn");
    const handle = spawn({
      cmd,
      cwd: options.cwd,
      timeout: options.timeout,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
    trace.endPhase("agent:spawn");

    this.activeHandle = handle;

    const promise: Promise<AgentExecutionResult> = handle.promise.then(
      (result) => {
        this.activeHandle = null;

        const { timings } = result;
        trace.recordPhase("agent:subprocess-spawn", timings.spawnMs);
        if (timings.firstStdoutMs !== null) {
          trace.recordPhase("agent:first-token-latency", timings.firstStdoutMs);
        }
        if (timings.firstStderrMs !== null) {
          trace.recordPhase("agent:first-stderr", timings.firstStderrMs);
        }
        trace.recordPhase("agent:total-execution", timings.totalMs);

        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          firstTokenMs: timings.firstStdoutMs,
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
