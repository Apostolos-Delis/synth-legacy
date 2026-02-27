import { loadavg, freemem, totalmem, cpus } from "node:os";

export interface ResourceSnapshot {
  loadAvg1m: number;
  cpuCount: number;
  freeMemPct: number;
  processRssMb: number;
}

export interface ResourceThresholds {
  criticalLoadPct: number;
  criticalMemPct: number;
  highLoadPct: number;
  highMemPct: number;
}

const DEFAULT_THRESHOLDS: ResourceThresholds = {
  criticalLoadPct: 95,
  criticalMemPct: 8,
  highLoadPct: 80,
  highMemPct: 15,
};

let cachedCpuCount: number | undefined;

export class ResourceMonitor {
  private readonly thresholds: ResourceThresholds;

  constructor(thresholds?: Partial<ResourceThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  snapshot(): ResourceSnapshot {
    const cpuCount = (cachedCpuCount ??= cpus().length);
    const total = totalmem();
    const free = freemem();
    const freeMemPct = (free / total) * 100;
    const rss = process.memoryUsage().rss;

    return {
      loadAvg1m: loadavg()[0],
      cpuCount,
      freeMemPct,
      processRssMb: rss / (1024 * 1024),
    };
  }

  recommendedConcurrency(maxDesired: number): { concurrency: number; reason: string | null } {
    const snap = this.snapshot();
    const loadPct = (snap.loadAvg1m / snap.cpuCount) * 100;

    if (loadPct > this.thresholds.criticalLoadPct || snap.freeMemPct < this.thresholds.criticalMemPct) {
      const reason = loadPct > this.thresholds.criticalLoadPct
        ? `load ${loadPct.toFixed(0)}% > ${this.thresholds.criticalLoadPct}%`
        : `free mem ${snap.freeMemPct.toFixed(0)}% < ${this.thresholds.criticalMemPct}%`;
      return { concurrency: 1, reason };
    }

    if (loadPct > this.thresholds.highLoadPct || snap.freeMemPct < this.thresholds.highMemPct) {
      const reason = loadPct > this.thresholds.highLoadPct
        ? `load ${loadPct.toFixed(0)}% > ${this.thresholds.highLoadPct}%`
        : `free mem ${snap.freeMemPct.toFixed(0)}% < ${this.thresholds.highMemPct}%`;
      return { concurrency: Math.ceil(maxDesired * 0.5), reason };
    }

    return { concurrency: maxDesired, reason: null };
  }
}
