import type { Subprocess } from "bun";

export interface SpawnOptions {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  stdin?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface SpawnTimings {
  spawnMs: number;
  firstStdoutMs: number | null;
  firstStderrMs: number | null;
  totalMs: number;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timings: SpawnTimings;
}

export interface SpawnHandle {
  pid: number;
  promise: Promise<SpawnResult>;
  interrupt(): void;
  process: Subprocess;
}

export function spawn(options: SpawnOptions): SpawnHandle {
  const { cmd, cwd, env, timeout, stdin, onStdout, onStderr } = options;

  const spawnStart = performance.now();
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdin: stdin !== undefined ? "pipe" : "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const spawnMs = performance.now() - spawnStart;

  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let firstStdoutMs: number | null = null;
  let firstStderrMs: number | null = null;

  if (stdin !== undefined && proc.stdin) {
    try {
      proc.stdin.write(stdin);
      proc.stdin.end();
    } catch {
    }
  }

  const promise = (async (): Promise<SpawnResult> => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const readStream = async (
      stream: ReadableStream<Uint8Array> | null,
      chunks: string[],
      cb?: (chunk: string) => void,
      onFirst?: () => void,
    ) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let first = true;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (first) {
            onFirst?.();
            first = false;
          }
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
      readStream(proc.stdout, stdoutChunks, onStdout, () => {
        firstStdoutMs = performance.now() - spawnStart;
      }),
      readStream(proc.stderr, stderrChunks, onStderr, () => {
        firstStderrMs = performance.now() - spawnStart;
      }),
    ]);

    const exitCode = await proc.exited;
    if (timeoutId) clearTimeout(timeoutId);

    const totalMs = performance.now() - spawnStart;

    return {
      exitCode,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
      timedOut,
      timings: { spawnMs, firstStdoutMs, firstStderrMs, totalMs },
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
