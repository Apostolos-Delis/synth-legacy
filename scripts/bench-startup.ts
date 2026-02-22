#!/usr/bin/env bun
/**
 * Startup benchmark for synth CLI.
 *
 * Spawns `bun src/cli.tsx --version` N times and measures time-to-first-output
 * as a proxy for startup latency. Reports p50/p95/p99 and asserts p95 < 300ms.
 *
 * Usage:
 *   bun scripts/bench-startup.ts              # default 15 iterations
 *   bun scripts/bench-startup.ts --iterations 30
 *   bun scripts/bench-startup.ts --json       # JSON-only output (no table)
 */

const DEFAULTS = {
  iterations: 15,
  p95Threshold: 300, // ms
};

function parseArgs(argv: string[]) {
  let iterations = DEFAULTS.iterations;
  let jsonOnly = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--iterations" && argv[i + 1]) {
      iterations = parseInt(argv[i + 1], 10);
      if (Number.isNaN(iterations) || iterations < 1) {
        console.error("--iterations must be a positive integer");
        process.exit(1);
      }
      i++;
    } else if (argv[i] === "--json") {
      jsonOnly = true;
    }
  }

  return { iterations, jsonOnly };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function measureOnce(cliPath: string): Promise<number> {
  const start = performance.now();

  const proc = Bun.spawn(["bun", cliPath, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });

  // Wait for first byte of stdout — this is our "first output" signal.
  const reader = proc.stdout.getReader();
  await reader.read();
  const elapsed = performance.now() - start;

  // Drain and wait for process to exit cleanly.
  reader.releaseLock();
  await proc.exited;

  return elapsed;
}

async function main() {
  const { iterations, jsonOnly } = parseArgs(process.argv.slice(2));
  const cliPath = new URL("../src/cli.tsx", import.meta.url).pathname;

  if (!jsonOnly) {
    console.log(`\nBenchmarking synth startup (${iterations} iterations)…\n`);
  }

  // Warmup run (not counted) — primes filesystem caches.
  await measureOnce(cliPath);

  const samples: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const ms = await measureOnce(cliPath);
    samples.push(ms);
    if (!jsonOnly) {
      const bar = "█".repeat(Math.min(60, Math.round(ms / 5)));
      console.log(`  ${String(i + 1).padStart(3)}  ${ms.toFixed(1).padStart(7)} ms  ${bar}`);
    }
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);

  const stats = {
    iterations,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };

  const p95Pass = stats.p95 < DEFAULTS.p95Threshold;

  const result = {
    timestamp: new Date().toISOString(),
    command: "bun src/cli.tsx --version",
    ...stats,
    min: round2(stats.min),
    max: round2(stats.max),
    mean: round2(stats.mean),
    p50: round2(stats.p50),
    p95: round2(stats.p95),
    p99: round2(stats.p99),
    thresholdMs: DEFAULTS.p95Threshold,
    pass: p95Pass,
    samples: sorted.map(round2),
  };

  if (!jsonOnly) {
    console.log("\n┌─ Startup Benchmark Results ────────────────────────────────┐\n");
    console.log(`  Iterations:  ${iterations}`);
    console.log(`  Min:         ${result.min.toFixed(2)} ms`);
    console.log(`  Max:         ${result.max.toFixed(2)} ms`);
    console.log(`  Mean:        ${result.mean.toFixed(2)} ms`);
    console.log(`  p50:         ${result.p50.toFixed(2)} ms`);
    console.log(`  p95:         ${result.p95.toFixed(2)} ms`);
    console.log(`  p99:         ${result.p99.toFixed(2)} ms`);
    console.log("");
    console.log(`  Threshold:   p95 < ${DEFAULTS.p95Threshold} ms → ${p95Pass ? "PASS ✓" : "FAIL ✗"}`);
    console.log("\n└────────────────────────────────────────────────────────────┘\n");
  }

  // Always emit JSON to stdout for trend tracking.
  console.log(JSON.stringify(result, null, 2));

  if (!p95Pass) {
    process.exit(1);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
