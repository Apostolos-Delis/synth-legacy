export interface TimerResult {
  name: string;
  durationMs: number;
}

export interface PhaseEntry {
  name: string;
  durationMs: number;
}

export interface PerfReport {
  phases: PhaseEntry[];
  totalMs: number;
}

interface PhaseState {
  startedAt: number | null;
  durationMs: number;
}

export function startTimer(): () => number {
  const start = performance.now();
  return () => performance.now() - start;
}

export class PerfTrace {
  private phases = new Map<string, PhaseState>();
  private order: string[] = [];
  private traceStart: number | null = null;
  enabled = false;

  addPhase(name: string): void {
    if (!this.enabled) return;
    if (this.phases.has(name)) return;
    this.phases.set(name, { startedAt: null, durationMs: 0 });
    this.order.push(name);
  }

  startPhase(name: string): void {
    if (!this.enabled) return;
    if (!this.phases.has(name)) {
      this.addPhase(name);
    }
    if (this.traceStart === null) {
      this.traceStart = performance.now();
    }
    const phase = this.phases.get(name)!;
    phase.startedAt = performance.now();
  }

  endPhase(name: string): void {
    if (!this.enabled) return;
    const phase = this.phases.get(name);
    if (!phase || phase.startedAt === null) return;
    phase.durationMs += performance.now() - phase.startedAt;
    phase.startedAt = null;
  }

  recordPhase(name: string, durationMs: number): void {
    if (!this.enabled) return;
    if (this.traceStart === null) {
      this.traceStart = performance.now();
    }
    if (!this.phases.has(name)) {
      this.addPhase(name);
    }
    this.phases.get(name)!.durationMs = durationMs;
  }

  report(): PerfReport {
    const phases: PhaseEntry[] = this.order.map((name) => ({
      name,
      durationMs: this.phases.get(name)!.durationMs,
    }));
    const totalMs =
      this.traceStart !== null ? performance.now() - this.traceStart : 0;
    return { phases, totalMs };
  }

  reset(): void {
    this.phases.clear();
    this.order = [];
    this.traceStart = null;
  }
}

export function formatReport(report: PerfReport): string {
  const nameWidth = Math.max(
    5,
    ...report.phases.map((p) => p.name.length),
  );
  const lines: string[] = [];

  const header = `${"Phase".padEnd(nameWidth)}  Duration (ms)`;
  lines.push(header);
  lines.push("-".repeat(header.length));

  for (const phase of report.phases) {
    const dur = phase.durationMs.toFixed(2).padStart(13);
    lines.push(`${phase.name.padEnd(nameWidth)}  ${dur}`);
  }

  lines.push("-".repeat(header.length));
  lines.push(
    `${"Total".padEnd(nameWidth)}  ${report.totalMs.toFixed(2).padStart(13)}`,
  );

  return lines.join("\n");
}

export function formatProfileReport(report: PerfReport): string {
  if (report.phases.length === 0) return "[profile] No phases recorded.";

  const nameWidth = Math.max(
    5,
    ...report.phases.map((p) => p.name.length),
  );
  const lines: string[] = [];

  lines.push("");
  lines.push("┌─ Performance Profile ─────────────────────────────────────┐");
  lines.push("");

  const header = `  ${"Phase".padEnd(nameWidth)}  ${"Duration (ms)".padStart(13)}  ${"% Total".padStart(8)}`;
  lines.push(header);
  lines.push(`  ${"─".repeat(nameWidth + 25)}`);

  const sorted = [...report.phases].sort(
    (a, b) => b.durationMs - a.durationMs,
  );

  for (const phase of report.phases) {
    const dur = phase.durationMs.toFixed(2).padStart(13);
    const pct =
      report.totalMs > 0
        ? ((phase.durationMs / report.totalMs) * 100).toFixed(1).padStart(7) +
          "%"
        : "    N/A";
    lines.push(`  ${phase.name.padEnd(nameWidth)}  ${dur}  ${pct}`);
  }

  lines.push(`  ${"─".repeat(nameWidth + 25)}`);
  lines.push(
    `  ${"Total".padEnd(nameWidth)}  ${report.totalMs.toFixed(2).padStart(13)}`,
  );

  // Top 3 bottlenecks
  const top3 = sorted.slice(0, 3);
  if (top3.length > 0) {
    lines.push("");
    lines.push("  Top bottlenecks:");
    for (let i = 0; i < top3.length; i++) {
      const p = top3[i];
      const pct =
        report.totalMs > 0
          ? ((p.durationMs / report.totalMs) * 100).toFixed(1)
          : "0.0";
      lines.push(
        `    ${i + 1}. ${p.name} — ${p.durationMs.toFixed(2)}ms (${pct}%)`,
      );
    }
  }

  lines.push("");
  lines.push("└───────────────────────────────────────────────────────────┘");

  return lines.join("\n");
}

export function formatProfileReportJson(report: PerfReport): string {
  const phases = report.phases.map((p) => ({
    name: p.name,
    durationMs: Math.round(p.durationMs * 100) / 100,
    pctOfTotal:
      report.totalMs > 0
        ? Math.round((p.durationMs / report.totalMs) * 1000) / 10
        : 0,
  }));
  const sorted = [...phases].sort((a, b) => b.durationMs - a.durationMs);
  return JSON.stringify(
    {
      totalMs: Math.round(report.totalMs * 100) / 100,
      phases,
      topBottlenecks: sorted.slice(0, 3).map((p) => p.name),
    },
    null,
    2,
  );
}

let _globalTrace: PerfTrace | null = null;

export function globalTrace(): PerfTrace {
  if (!_globalTrace) {
    _globalTrace = new PerfTrace();
  }
  return _globalTrace;
}
