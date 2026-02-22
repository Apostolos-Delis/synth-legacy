/**
 * Streaming render throughput benchmark.
 *
 * Measures how fast OutputPane can render progressively larger output payloads,
 * simulating real-time agent streaming. Uses OpenTUI's headless test renderer.
 * Asserts throughput > 5 000 lines/s.
 */

import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { OutputPane } from "../../src/tui/components/OutputPane.js";
import type { BenchmarkResult } from "../bench.js";

const THROUGHPUT_THRESHOLD = 5_000; // lines per second minimum
const CHUNK_SIZE = 200; // lines added per render cycle
const TOTAL_LINES = 2_000;
const ITERATIONS = Math.ceil(TOTAL_LINES / CHUNK_SIZE);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function generateLines(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(`[${String(i + 1).padStart(5, "0")}] Building module src/components/Widget${i}.tsx... ok (${(Math.random() * 50).toFixed(1)}ms)`);
  }
  return lines.join("\n");
}

export async function runStreamingRenderBenchmark(): Promise<BenchmarkResult> {
  let currentOutput = "";

  const element = createElement(OutputPane, {
    output: currentOutput,
    width: 120,
    height: 40,
    isThinking: false,
    currentPhase: null,
    phaseStartTime: null,
  });

  const { renderOnce } = await testRender(element, { width: 120, height: 40 });

  // Initial render
  await renderOnce();

  const renderTimes: number[] = [];
  let totalLinesRendered = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    // Append a new chunk of lines
    const newChunk = generateLines(CHUNK_SIZE);
    currentOutput = currentOutput ? currentOutput + "\n" + newChunk : newChunk;
    totalLinesRendered += CHUNK_SIZE;

    // Re-render with updated output by creating a new element
    const updated = createElement(OutputPane, {
      output: currentOutput,
      width: 120,
      height: 40,
      isThinking: false,
      currentPhase: null,
      phaseStartTime: null,
    });

    // Measure render time — this includes React reconciliation + OpenTUI layout
    const start = performance.now();
    await testRender(updated, { width: 120, height: 40 }).then(({ renderOnce: ro }) => ro());
    const elapsed = performance.now() - start;

    renderTimes.push(elapsed);
  }

  const totalRenderMs = renderTimes.reduce((a, b) => a + b, 0);
  const throughput = round2((totalLinesRendered / totalRenderMs) * 1000);
  const avgRenderMs = round2(totalRenderMs / renderTimes.length);
  const maxRenderMs = round2(Math.max(...renderTimes));

  return {
    suite: "streaming-render",
    pass: throughput > THROUGHPUT_THRESHOLD,
    metrics: { throughput, avgRenderMs, maxRenderMs, totalLines: totalLinesRendered },
    threshold: { metric: "throughput", operator: ">", value: THROUGHPUT_THRESHOLD },
  };
}
