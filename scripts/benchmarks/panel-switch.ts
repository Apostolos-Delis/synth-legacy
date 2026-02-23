/**
 * Panel switch latency benchmark.
 *
 * Uses OpenTUI's headless test renderer to measure the time it takes to
 * toggle between execution and dashboard views (pressing 'd').
 * Asserts p95 < 50ms per switch.
 */

import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui/App.js";
import type { BenchmarkResult } from "../bench.js";

const ITERATIONS = 20;
const P95_THRESHOLD_MS = 50;

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function makeMockProps() {
  return {
    engineState: "executing" as const,
    iteration: 1,
    maxIterations: 10,
    tasks: [
      {
        id: "US-001",
        title: "Test task",
        description: "A test task",
        acceptanceCriteria: ["It works"],
        priority: 1 as const,
        status: "in_progress" as const,
        iterationCount: 1,
      },
    ],
    currentTaskId: "US-001",
    output: "Building project...\nRunning tests...\nAll tests passed.",
    agentName: "claude",
    projectName: "bench-test",
    sessionId: "bench-001",
    startTime: Date.now(),
    interviewMessages: [],
    isThinking: false,
    currentPhase: null,
    phaseStartTime: null,
    defaultView: "execution" as const,
  };
}

export async function runPanelSwitchBenchmark(): Promise<BenchmarkResult> {
  const props = makeMockProps();
  const { mockInput, renderOnce } = await testRender(
    createElement(App, props),
    { width: 120, height: 40 },
  );

  // Initial render
  await renderOnce();

  const samples: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();

    // Press 'd' to toggle view
    mockInput.pressKey("d");
    await renderOnce();

    const elapsed = performance.now() - start;
    samples.push(elapsed);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p50 = round2(percentile(sorted, 50));
  const p95 = round2(percentile(sorted, 95));
  const mean = round2(sum / sorted.length);

  return {
    suite: "panel-switch",
    pass: p95 < P95_THRESHOLD_MS,
    metrics: { p50, p95, mean },
    threshold: { metric: "p95", operator: "<", value: P95_THRESHOLD_MS },
    samples: sorted.map(round2),
  };
}
