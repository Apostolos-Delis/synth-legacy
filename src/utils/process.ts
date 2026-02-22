import type { Subprocess } from "bun";

export interface SpawnOptions {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SpawnHandle {
  pid: number;
  promise: Promise<SpawnResult>;
  interrupt(): void;
  process: Subprocess;
}

export function spawn(options: SpawnOptions): SpawnHandle {
  const { cmd, cwd, env, timeout, onStdout, onStderr } = options;

  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const promise = (async (): Promise<SpawnResult> => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const readStream = async (
      stream: ReadableStream<Uint8Array> | null,
      chunks: string[],
      cb?: (chunk: string) => void,
    ) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          chunks.push(text);
          cb?.(text);
        }
      } catch {
        // Stream closed, expected during interrupt
      }
    };

    if (timeout) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
      }, timeout);
    }

    await Promise.all([
      readStream(proc.stdout, stdoutChunks, onStdout),
      readStream(proc.stderr, stderrChunks, onStderr),
    ]);

    const exitCode = await proc.exited;
    if (timeoutId) clearTimeout(timeoutId);

    return {
      exitCode,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
      timedOut,
    };
  })();

  return {
    pid: proc.pid,
    promise,
    interrupt() {
      proc.kill("SIGTERM");
    },
    process: proc,
  };
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
