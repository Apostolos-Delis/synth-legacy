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

  addPhase(name: string): void {
    if (this.phases.has(name)) return;
    this.phases.set(name, { startedAt: null, durationMs: 0 });
    this.order.push(name);
  }

  startPhase(name: string): void {
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
    const phase = this.phases.get(name);
    if (!phase || phase.startedAt === null) return;
    phase.durationMs += performance.now() - phase.startedAt;
    phase.startedAt = null;
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

let _globalTrace: PerfTrace | null = null;

export function globalTrace(): PerfTrace {
  if (!_globalTrace) {
    _globalTrace = new PerfTrace();
  }
  return _globalTrace;
}
