#!/usr/bin/env bun
/**
 * Import timing profiler for src/cli.tsx
 *
 * Measures the load cost of each top-level module imported by cli.tsx.
 * Run: bun scripts/profile-imports.ts
 */

interface ImportTiming {
  module: string;
  durationMs: number;
  neededForFirstRender: boolean;
  category: string;
}

async function timeImport(
  label: string,
  importFn: () => Promise<unknown>,
): Promise<number> {
  const start = performance.now();
  await importFn();
  return performance.now() - start;
}

async function main() {
  const results: ImportTiming[] = [];

  // Measure baseline startup: just the process reaching this point
  const processStart = performance.now();

  // ── Node built-ins ──
  results.push({
    module: "node:path",
    durationMs: await timeImport("node:path", () => import("node:path")),
    neededForFirstRender: true,
    category: "node-builtin",
  });

  results.push({
    module: "node:os",
    durationMs: await timeImport("node:os", () => import("node:os")),
    neededForFirstRender: false,
    category: "node-builtin",
  });

  results.push({
    module: "node:fs/promises",
    durationMs: await timeImport("node:fs/promises", () => import("node:fs/promises")),
    neededForFirstRender: false,
    category: "node-builtin",
  });

  results.push({
    module: "node:readline",
    durationMs: await timeImport("node:readline", () => import("node:readline")),
    neededForFirstRender: false,
    category: "node-builtin",
  });

  // ── Third-party deps ──
  results.push({
    module: "smol-toml",
    durationMs: await timeImport("smol-toml", () => import("smol-toml")),
    neededForFirstRender: false,
    category: "third-party",
  });

  results.push({
    module: "node-notifier",
    durationMs: await timeImport("node-notifier", () => import("node-notifier")),
    neededForFirstRender: false,
    category: "third-party",
  });

  results.push({
    module: "@opentui/core",
    durationMs: await timeImport("@opentui/core", () => import("@opentui/core")),
    neededForFirstRender: false,
    category: "third-party",
  });

  results.push({
    module: "@opentui/react",
    durationMs: await timeImport("@opentui/react", () => import("@opentui/react")),
    neededForFirstRender: false,
    category: "third-party",
  });

  results.push({
    module: "react",
    durationMs: await timeImport("react", () => import("react")),
    neededForFirstRender: false,
    category: "third-party",
  });

  // ── Internal: config ──
  results.push({
    module: "config/loader",
    durationMs: await timeImport("config/loader", () => import("../src/config/loader.js")),
    neededForFirstRender: false,
    category: "internal-config",
  });

  // ── Internal: plans ──
  results.push({
    module: "plans/registry",
    durationMs: await timeImport("plans/registry", () => import("../src/plans/registry.js")),
    neededForFirstRender: false,
    category: "internal-plans",
  });

  // ── Internal: tasks ──
  results.push({
    module: "tasks/store",
    durationMs: await timeImport("tasks/store", () => import("../src/tasks/store.js")),
    neededForFirstRender: false,
    category: "internal-tasks",
  });

  results.push({
    module: "tasks/planner",
    durationMs: await timeImport("tasks/planner", () => import("../src/tasks/planner.js")),
    neededForFirstRender: false,
    category: "internal-tasks",
  });

  // ── Internal: agents ──
  results.push({
    module: "agents/registry",
    durationMs: await timeImport("agents/registry", () => import("../src/agents/registry.js")),
    neededForFirstRender: false,
    category: "internal-agents",
  });

  results.push({
    module: "agents/claude",
    durationMs: await timeImport("agents/claude", () => import("../src/agents/claude.js")),
    neededForFirstRender: false,
    category: "internal-agents",
  });

  results.push({
    module: "agents/codex",
    durationMs: await timeImport("agents/codex", () => import("../src/agents/codex.js")),
    neededForFirstRender: false,
    category: "internal-agents",
  });

  // ── Internal: engine ──
  results.push({
    module: "engine/engine",
    durationMs: await timeImport("engine/engine", () => import("../src/engine/engine.js")),
    neededForFirstRender: false,
    category: "internal-engine",
  });

  results.push({
    module: "engine/circuit-breaker",
    durationMs: await timeImport("engine/circuit-breaker", () => import("../src/engine/circuit-breaker.js")),
    neededForFirstRender: false,
    category: "internal-engine",
  });

  results.push({
    module: "engine/rate-limit",
    durationMs: await timeImport("engine/rate-limit", () => import("../src/engine/rate-limit.js")),
    neededForFirstRender: false,
    category: "internal-engine",
  });

  results.push({
    module: "engine/backpressure",
    durationMs: await timeImport("engine/backpressure", () => import("../src/engine/backpressure.js")),
    neededForFirstRender: false,
    category: "internal-engine",
  });

  // ── Internal: session ──
  results.push({
    module: "session/session",
    durationMs: await timeImport("session/session", () => import("../src/session/session.js")),
    neededForFirstRender: false,
    category: "internal-session",
  });

  // ── Internal: interview ──
  results.push({
    module: "interview/interviewer",
    durationMs: await timeImport("interview/interviewer", () => import("../src/interview/interviewer.js")),
    neededForFirstRender: false,
    category: "internal-interview",
  });

  // ── Internal: finalize ──
  results.push({
    module: "finalize/finalize",
    durationMs: await timeImport("finalize/finalize", () => import("../src/finalize/finalize.js")),
    neededForFirstRender: false,
    category: "internal-finalize",
  });

  results.push({
    module: "finalize/review",
    durationMs: await timeImport("finalize/review", () => import("../src/finalize/review.js")),
    neededForFirstRender: false,
    category: "internal-finalize",
  });

  results.push({
    module: "finalize/formatter",
    durationMs: await timeImport("finalize/formatter", () => import("../src/finalize/formatter.js")),
    neededForFirstRender: false,
    category: "internal-finalize",
  });

  results.push({
    module: "finalize/splitter",
    durationMs: await timeImport("finalize/splitter", () => import("../src/finalize/splitter.js")),
    neededForFirstRender: false,
    category: "internal-finalize",
  });

  results.push({
    module: "finalize/pr",
    durationMs: await timeImport("finalize/pr", () => import("../src/finalize/pr.js")),
    neededForFirstRender: false,
    category: "internal-finalize",
  });

  // ── Internal: prompts ──
  results.push({
    module: "prompts/build",
    durationMs: await timeImport("prompts/build", () => import("../src/prompts/build.js")),
    neededForFirstRender: false,
    category: "internal-prompts",
  });

  results.push({
    module: "prompts/instructions",
    durationMs: await timeImport("prompts/instructions", () => import("../src/prompts/instructions.js")),
    neededForFirstRender: false,
    category: "internal-prompts",
  });

  // ── Internal: notifications ──
  results.push({
    module: "notifications",
    durationMs: await timeImport("notifications", () => import("../src/notifications.js")),
    neededForFirstRender: false,
    category: "internal-notifications",
  });

  // ── Internal: utils ──
  results.push({
    module: "utils/fs",
    durationMs: await timeImport("utils/fs", () => import("../src/utils/fs.js")),
    neededForFirstRender: true,
    category: "internal-utils",
  });

  results.push({
    module: "utils/process",
    durationMs: await timeImport("utils/process", () => import("../src/utils/process.js")),
    neededForFirstRender: false,
    category: "internal-utils",
  });

  results.push({
    module: "utils/perf",
    durationMs: await timeImport("utils/perf", () => import("../src/utils/perf.js")),
    neededForFirstRender: true,
    category: "internal-utils",
  });

  // ── Internal: TUI theme/spinners ──
  results.push({
    module: "tui/theme",
    durationMs: await timeImport("tui/theme", () => import("../src/tui/theme.js")),
    neededForFirstRender: true,
    category: "internal-tui",
  });

  results.push({
    module: "tui/themes/resolve",
    durationMs: await timeImport("tui/themes/resolve", () => import("../src/tui/themes/resolve.js")),
    neededForFirstRender: false,
    category: "internal-tui",
  });

  results.push({
    module: "tui/themes/registry",
    durationMs: await timeImport("tui/themes/registry", () => import("../src/tui/themes/registry.js")),
    neededForFirstRender: false,
    category: "internal-tui",
  });

  results.push({
    module: "tui/spinners",
    durationMs: await timeImport("tui/spinners", () => import("../src/tui/spinners.js")),
    neededForFirstRender: false,
    category: "internal-tui",
  });

  results.push({
    module: "tui/spinner",
    durationMs: await timeImport("tui/spinner", () => import("../src/tui/spinner.js")),
    neededForFirstRender: false,
    category: "internal-tui",
  });

  results.push({
    module: "tui/utils",
    durationMs: await timeImport("tui/utils", () => import("../src/tui/utils.js")),
    neededForFirstRender: false,
    category: "internal-tui",
  });

  const totalMs = performance.now() - processStart;

  // ── Report ──
  const sorted = [...results].sort((a, b) => b.durationMs - a.durationMs);

  const nameWidth = Math.max(30, ...results.map((r) => r.module.length + 2));

  console.log("\n┌─ Import Timing Audit ─────────────────────────────────────────────┐\n");
  console.log(
    `  ${"Module".padEnd(nameWidth)}  ${"Time (ms)".padStart(10)}  ${"Category".padEnd(20)}  First Render?`,
  );
  console.log(`  ${"─".repeat(nameWidth + 48)}`);

  for (const r of sorted) {
    const ms = r.durationMs.toFixed(2).padStart(10);
    const needed = r.neededForFirstRender ? "  ✓" : "  ✗  ← defer candidate";
    console.log(
      `  ${r.module.padEnd(nameWidth)}  ${ms}  ${r.category.padEnd(20)}${needed}`,
    );
  }

  console.log(`\n  ${"─".repeat(nameWidth + 48)}`);
  console.log(`  ${"Total import time".padEnd(nameWidth)}  ${totalMs.toFixed(2).padStart(10)} ms`);

  // ── Summary by category ──
  const byCategory = new Map<string, number>();
  for (const r of results) {
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.durationMs);
  }

  console.log(`\n  Category breakdown:`);
  const catEntries = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
  for (const [cat, ms] of catEntries) {
    console.log(`    ${cat.padEnd(25)} ${ms.toFixed(2).padStart(10)} ms`);
  }

  // ── Deferral candidates ──
  const deferCandidates = sorted.filter((r) => !r.neededForFirstRender);
  const deferTotal = deferCandidates.reduce((s, r) => s + r.durationMs, 0);

  console.log(`\n  Deferral summary:`);
  console.log(`    Modules not needed for first render: ${deferCandidates.length}`);
  console.log(`    Combined load time of deferrable:    ${deferTotal.toFixed(2)} ms`);
  console.log(`    Potential startup savings:           ~${deferTotal.toFixed(0)} ms`);

  // ── Top 10 deferral candidates ──
  console.log(`\n  Top 10 deferral candidates (highest cost):`);
  for (let i = 0; i < Math.min(10, deferCandidates.length); i++) {
    const r = deferCandidates[i];
    console.log(`    ${i + 1}. ${r.module.padEnd(30)} ${r.durationMs.toFixed(2).padStart(8)} ms  [${r.category}]`);
  }

  console.log("\n└───────────────────────────────────────────────────────────────────┘\n");

  // Output JSON for docs
  return { results: sorted, totalMs, deferCandidates: deferCandidates.map((r) => ({ module: r.module, durationMs: Math.round(r.durationMs * 100) / 100, category: r.category })) };
}

main().catch(console.error);
