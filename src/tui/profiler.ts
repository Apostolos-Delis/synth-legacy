import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionPaths } from "../sessions/types.js";

type SpanStats = { count: number; totalMs: number; maxMs: number; minMs: number };

class TuiProfiler {
  enabled = false;
  private path: string | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private spans = new Map<string, SpanStats>();
  private events = new Map<string, number>();
  private dirty = false;
  private ensuringDir = false;

  start(sessionPaths: SessionPaths): void {
    this.enabled = process.env.SYNTH_TUI_PROFILE === "1";
    if (!this.enabled || this.path) return;
    this.path = join(sessionPaths.logs, "tui-profile.jsonl");
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, 1000);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    void this.flush();
  }

  startSpan(_name: string): number | null {
    if (!this.enabled) return null;
    return performance.now();
  }

  endSpan(name: string, start: number | null): void {
    if (!this.enabled || start === null) return;
    this.recordSpan(name, performance.now() - start);
  }

  recordSpan(name: string, durationMs: number): void {
    if (!this.enabled) return;
    const stat = this.spans.get(name);
    if (stat) {
      stat.count += 1;
      stat.totalMs += durationMs;
      if (durationMs > stat.maxMs) stat.maxMs = durationMs;
      if (durationMs < stat.minMs) stat.minMs = durationMs;
    } else {
      this.spans.set(name, {
        count: 1,
        totalMs: durationMs,
        maxMs: durationMs,
        minMs: durationMs,
      });
    }
    this.dirty = true;
  }

  countEvent(name: string, delta = 1): void {
    if (!this.enabled) return;
    this.events.set(name, (this.events.get(name) ?? 0) + delta);
    this.dirty = true;
  }

  private async ensureDir(): Promise<void> {
    if (!this.path || this.ensuringDir) return;
    this.ensuringDir = true;
    try {
      await mkdir(dirname(this.path), { recursive: true });
    } finally {
      this.ensuringDir = false;
    }
  }

  private async flush(): Promise<void> {
    if (!this.enabled || !this.path || !this.dirty) return;
    const spans = this.spans;
    const events = this.events;
    this.spans = new Map();
    this.events = new Map();
    this.dirty = false;

    const spanList = Array.from(spans.entries()).map(([name, stat]) => ({
      name,
      count: stat.count,
      totalMs: Math.round(stat.totalMs * 100) / 100,
      maxMs: Math.round(stat.maxMs * 100) / 100,
      minMs: Math.round(stat.minMs * 100) / 100,
      avgMs: Math.round((stat.totalMs / stat.count) * 100) / 100,
    }));

    const payload = {
      ts: new Date().toISOString(),
      spans: spanList,
      events: Object.fromEntries(events.entries()),
      mem: typeof process.memoryUsage === "function" ? process.memoryUsage() : undefined,
    };

    try {
      await this.ensureDir();
      await appendFile(this.path, JSON.stringify(payload) + "\n");
    } catch {
    }
  }
}

const profiler = new TuiProfiler();

export function startTuiProfiler(sessionPaths: SessionPaths): void {
  profiler.start(sessionPaths);
}

export function stopTuiProfiler(): void {
  profiler.stop();
}

export function startSpan(name: string): number | null {
  return profiler.startSpan(name);
}

export function endSpan(name: string, start: number | null): void {
  profiler.endSpan(name, start);
}

export function recordSpan(name: string, durationMs: number): void {
  profiler.recordSpan(name, durationMs);
}

export function countEvent(name: string, delta = 1): void {
  profiler.countEvent(name, delta);
}
