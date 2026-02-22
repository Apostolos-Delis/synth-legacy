/**
 * Startup latency benchmark.
 *
 * Spawns `bun src/cli.tsx --version` and measures time-to-first-output.
 * Asserts p95 < 300ms.
 */

import type { BenchmarkResult } from "../bench.js";

const ITERATIONS = 10;
const P95_THRESHOLD_MS = 300;

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function measureOnce(cliPath: string): Promise<number> {
  const start = performance.now();

  const proc = Bun.spawn(["bun", cliPath, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });

  const reader = proc.stdout.getReader();
  await reader.read();
  const elapsed = performance.now() - start;

  reader.releaseLock();
  await proc.exited;

  return elapsed;
}

export async function runStartupBenchmark(): Promise<BenchmarkResult> {
  const cliPath = new URL("../../src/cli.tsx", import.meta.url).pathname;

  // Warmup run
  await measureOnce(cliPath);

  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    samples.push(await measureOnce(cliPath));
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p50 = round2(percentile(sorted, 50));
  const p95 = round2(percentile(sorted, 95));
  const p99 = round2(percentile(sorted, 99));
  const mean = round2(sum / sorted.length);

  return {
    suite: "startup",
    pass: p95 < P95_THRESHOLD_MS,
    metrics: { p50, p95, p99, mean },
    threshold: { metric: "p95", operator: "<", value: P95_THRESHOLD_MS },
    samples: sorted.map(round2),
  };
}
