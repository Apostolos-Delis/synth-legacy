#!/usr/bin/env bun
/**
 * Unified benchmark suite for synth.
 *
 * Runs three benchmark categories:
 *   1. Startup latency  — time-to-first-output of `bun src/cli.tsx --version`
 *   2. Panel switch      — view toggle render latency via headless TUI renderer
 *   3. Streaming render   — OutputPane throughput with large output payloads
 *
 * Usage:
 *   bun scripts/bench.ts              # run all benchmarks
 *   bun scripts/bench.ts --json       # JSON-only output (for CI artifact capture)
 *   bun scripts/bench.ts --suite startup,panel-switch  # run specific suites
 */

import { runStartupBenchmark } from "./benchmarks/startup.js";
import { runPanelSwitchBenchmark } from "./benchmarks/panel-switch.js";
import { runStreamingRenderBenchmark } from "./benchmarks/streaming-render.js";

export interface BenchmarkResult {
  suite: string;
  pass: boolean;
  metrics: Record<string, number>;
  threshold: { metric: string; operator: "<" | ">"; value: number };
  samples?: number[];
}

export interface BenchmarkReport {
  timestamp: string;
  totalDurationMs: number;
  allPassed: boolean;
  results: BenchmarkResult[];
}

type SuiteName = "startup" | "panel-switch" | "streaming-render";
type SuiteRunner = () => Promise<BenchmarkResult>;

const SUITES: Record<SuiteName, SuiteRunner> = {
  "startup": runStartupBenchmark,
  "panel-switch": runPanelSwitchBenchmark,
  "streaming-render": runStreamingRenderBenchmark,
};

function parseArgs(argv: string[]) {
  let jsonOnly = false;
  let suites: SuiteName[] | null = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") {
      jsonOnly = true;
    } else if (argv[i] === "--suite" && argv[i + 1]) {
      suites = argv[i + 1].split(",").map((s) => s.trim()) as SuiteName[];
      i++;
    }
  }

  return { jsonOnly, suites };
}

function formatMetric(key: string, value: number): string {
  if (key.includes("throughput")) return `${value.toLocaleString()} lines/s`;
  if (key === "totalLines") return `${value.toLocaleString()}`;
  return `${value.toFixed(2)} ms`;
}

async function main() {
  const { jsonOnly, suites } = parseArgs(process.argv.slice(2));
  const suitesToRun = suites ?? (Object.keys(SUITES) as SuiteName[]);

  // Validate suite names
  for (const name of suitesToRun) {
    if (!(name in SUITES)) {
      console.error(`Unknown suite: ${name}. Available: ${Object.keys(SUITES).join(", ")}`);
      process.exit(1);
    }
  }

  if (!jsonOnly) {
    console.log(`\nRunning ${suitesToRun.length} benchmark suite(s)…\n`);
  }

  const totalStart = performance.now();
  const results: BenchmarkResult[] = [];

  for (const name of suitesToRun) {
    if (!jsonOnly) {
      console.log(`  ▸ ${name}…`);
    }

    const result = await SUITES[name]();
    results.push(result);

    if (!jsonOnly) {
      const status = result.pass ? "PASS" : "FAIL";
      const metrics = Object.entries(result.metrics)
        .map(([k, v]) => `${k}=${formatMetric(k, v)}`)
        .join(", ");
      console.log(`    ${status} — ${metrics}`);
    }
  }

  const totalDurationMs = performance.now() - totalStart;
  const allPassed = results.every((r) => r.pass);

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    totalDurationMs: Math.round(totalDurationMs * 100) / 100,
    allPassed,
    results,
  };

  if (!jsonOnly) {
    console.log("\n┌─ Benchmark Summary ────────────────────────────────────────┐\n");
    for (const r of results) {
      const icon = r.pass ? "✓" : "✗";
      const assertion = `${r.threshold.metric} ${r.threshold.operator} ${formatMetric(r.threshold.metric, r.threshold.value)}`;
      console.log(`  ${icon} ${r.suite.padEnd(20)} ${assertion}`);
    }
    console.log(`\n  Total: ${(totalDurationMs / 1000).toFixed(1)}s`);
    console.log(`  Result: ${allPassed ? "ALL PASSED" : "FAILED"}`);
    console.log("\n└────────────────────────────────────────────────────────────┘\n");
  }

  console.log(JSON.stringify(report, null, 2));

  if (!allPassed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
