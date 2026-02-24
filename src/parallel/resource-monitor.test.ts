import { describe, test, expect, mock, beforeEach } from "bun:test";

let mockLoadAvg = [1.0];
let mockCpuCount = 8;
let mockFreeMem = 8_000_000_000;
let mockTotalMem = 16_000_000_000;
let mockRss = 200_000_000;

mock.module("node:os", () => ({
  loadavg: () => mockLoadAvg,
  cpus: () => Array.from({ length: mockCpuCount }, () => ({})),
  freemem: () => mockFreeMem,
  totalmem: () => mockTotalMem,
}));

// Override process.memoryUsage for tests
process.memoryUsage = (() => ({
  rss: mockRss,
  heapTotal: 0,
  heapUsed: 0,
  external: 0,
  arrayBuffers: 0,
})) as typeof process.memoryUsage;

import { ResourceMonitor } from "./resource-monitor.js";

beforeEach(() => {
  mockLoadAvg = [1.0];
  mockCpuCount = 8;
  mockFreeMem = 8_000_000_000;
  mockTotalMem = 16_000_000_000;
  mockRss = 200_000_000;
});

describe("ResourceMonitor", () => {
  describe("snapshot", () => {
    test("returns system resource snapshot", () => {
      const monitor = new ResourceMonitor();
      const snap = monitor.snapshot();

      expect(snap.loadAvg1m).toBe(1.0);
      expect(snap.cpuCount).toBe(8);
      expect(snap.freeMemPct).toBeCloseTo(50, 0);
      expect(snap.processRssMb).toBeCloseTo(200 / 1.048576, -1);
    });

    test("reflects updated mock values", () => {
      mockLoadAvg = [4.0];
      mockCpuCount = 4;
      mockFreeMem = 2_000_000_000;
      mockTotalMem = 16_000_000_000;

      const monitor = new ResourceMonitor();
      const snap = monitor.snapshot();

      expect(snap.loadAvg1m).toBe(4.0);
      expect(snap.cpuCount).toBe(4);
      expect(snap.freeMemPct).toBeCloseTo(12.5, 1);
    });
  });

  describe("recommendedConcurrency", () => {
    test("returns maxDesired when system is healthy", () => {
      // load = 1.0 / 8 cpus = 12.5% — well below thresholds
      // freeMem = 50% — well above thresholds
      const monitor = new ResourceMonitor();
      const result = monitor.recommendedConcurrency(8);

      expect(result.concurrency).toBe(8);
      expect(result.reason).toBeNull();
    });

    test("returns ceil(max * 0.5) when load is high", () => {
      // load = 7.0 / 8 cpus = 87.5% — above 80% high threshold
      mockLoadAvg = [7.0];

      const monitor = new ResourceMonitor();
      const result = monitor.recommendedConcurrency(8);

      expect(result.concurrency).toBe(4); // ceil(8 * 0.5)
      expect(result.reason).toContain("load");
    });

    test("returns ceil(max * 0.5) when free memory is low", () => {
      // freeMem = 2GB / 16GB = 12.5% — below 15% high threshold
      mockFreeMem = 2_000_000_000;

      const monitor = new ResourceMonitor();
      const result = monitor.recommendedConcurrency(6);

      expect(result.concurrency).toBe(3); // ceil(6 * 0.5)
      expect(result.reason).toContain("free mem");
    });

    test("returns 1 when load is critical", () => {
      // load = 8.0 / 8 cpus = 100% — above 95% critical threshold
      mockLoadAvg = [8.0];

      const monitor = new ResourceMonitor();
      const result = monitor.recommendedConcurrency(8);

      expect(result.concurrency).toBe(1);
      expect(result.reason).toContain("load");
    });

    test("returns 1 when free memory is critically low", () => {
      // freeMem = 1GB / 16GB = 6.25% — below 8% critical threshold
      mockFreeMem = 1_000_000_000;

      const monitor = new ResourceMonitor();
      const result = monitor.recommendedConcurrency(8);

      expect(result.concurrency).toBe(1);
      expect(result.reason).toContain("free mem");
    });

    test("never returns less than 1", () => {
      mockLoadAvg = [100.0]; // extreme load

      const monitor = new ResourceMonitor();
      const result = monitor.recommendedConcurrency(1);

      expect(result.concurrency).toBe(1);
    });

    test("respects custom thresholds", () => {
      // Default would be healthy, but custom thresholds make it high
      mockLoadAvg = [4.0]; // 50% on 8 cpus

      const monitor = new ResourceMonitor({
        highLoadPct: 40, // custom: treat 50% as high
      });
      const result = monitor.recommendedConcurrency(8);

      expect(result.concurrency).toBe(4); // ceil(8 * 0.5)
      expect(result.reason).toContain("load");
    });

    test("custom critical thresholds override defaults", () => {
      mockLoadAvg = [4.0]; // 50% on 8 cpus

      const monitor = new ResourceMonitor({
        criticalLoadPct: 45, // custom: treat 50% as critical
      });
      const result = monitor.recommendedConcurrency(8);

      expect(result.concurrency).toBe(1);
    });

    test("handles odd maxDesired for half-throttle ceiling", () => {
      mockLoadAvg = [7.0]; // high load

      const monitor = new ResourceMonitor();
      const result = monitor.recommendedConcurrency(5);

      expect(result.concurrency).toBe(3); // ceil(5 * 0.5)
    });
  });
});
