import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  AgentAdapter,
  AgentDetectResult,
  AgentExecuteOptions,
  AgentExecutionHandle,
  AgentExecutionResult,
} from "./types.js";
import type { DoctorCheckResult } from "../doctor/types.js";
import { spawn } from "../utils/process.js";
import { globalTrace } from "../utils/perf.js";

export abstract class BaseAgentAdapter implements AgentAdapter {
  abstract readonly name: string;
  private activeHandle: ReturnType<typeof spawn> | null = null;

  protected abstract buildCmd(prompt: string, options: AgentExecuteOptions): string[];

  get cliCommand(): string {
    return this.name;
  }

  get installHint(): string {
    return `install with: npm install -g ${this.name}`;
  }

  async checkAuth(): Promise<DoctorCheckResult | null> {
    return null;
  }

  async detect(): Promise<AgentDetectResult> {
    try {
      const handle = spawn({ cmd: [this.cliCommand, "--version"] });
      const result = await handle.promise;
      if (result.exitCode === 0) {
        return { available: true, version: result.stdout.trim() };
      }
      return { available: false, error: result.stderr.trim() };
    } catch {
      return { available: false, error: `${this.cliCommand} CLI not found` };
    }
  }

  execute(prompt: string, options: AgentExecuteOptions): AgentExecutionHandle {
    const trace = globalTrace();
    const cmd = this.buildCmd(prompt, options);
    const env: Record<string, string> = {};
    if (options.cwd) {
      const repoName = basename(options.cwd) || "repo";
      const runId = `${process.pid}-${Date.now()}`;
      const tmpDir = join(homedir(), ".synth", "tmp", repoName, runId);
      try {
        mkdirSync(tmpDir, { recursive: true });
        env.TMPDIR = tmpDir;
        env.TMP = tmpDir;
        env.TEMP = tmpDir;
      } catch {}
    }

    trace.startPhase("agent:spawn");
    const handle = spawn({
      cmd,
      cwd: options.cwd,
      timeout: options.timeout,
      stdin: options.stdin,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      env,
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
          rawStdout: result.stdout,
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
