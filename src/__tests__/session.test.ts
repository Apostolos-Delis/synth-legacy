import { describe, test, expect } from "bun:test";
import { hostname } from "node:os";
import {
  createRun,
  loadRun,
  updateRun,
  endRun,
  acquireLock,
  releaseLock,
  checkLock,
} from "../run/run.js";
import { writeJson } from "../utils/fs.js";
import { makeSessionPaths, withTmpDir } from "./helpers.js";
import type { LockFile } from "../run/types.js";

describe("run lifecycle", () => {
  test("createRun writes run.json with correct structure", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const run = await createRun(paths, "plan-1", "claude", 10, "/tmp");
      expect(run.id).toMatch(/^run-/);
      expect(run.planId).toBe("plan-1");
      expect(run.status).toBe("running");
      expect(run.agent).toBe("claude");
      expect(run.currentIteration).toBe(0);
      expect(run.maxIterations).toBe(10);
      expect(run.cwd).toBe("/tmp");
      expect(run.startedAt).toBeDefined();
      expect(run.updatedAt).toBeDefined();
    });
  });

  test("loadRun reads back what was written", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const created = await createRun(paths, "plan-1", "claude", 10, "/tmp");
      const loaded = await loadRun(paths);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(created.id);
      expect(loaded!.planId).toBe("plan-1");
      expect(loaded!.status).toBe("running");
    });
  });

  test("loadRun returns null when no run exists", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const run = await loadRun(paths);
      expect(run).toBeNull();
    });
  });

  test("updateRun merges fields and bumps updatedAt", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const created = await createRun(paths, "plan-1", "claude", 10, "/tmp");
      const updated = await updateRun(paths, { currentIteration: 3 });
      expect(updated.currentIteration).toBe(3);
      expect(updated.id).toBe(created.id);
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updatedAt).getTime(),
      );
    });
  });

  test("updateRun throws when no run exists", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      expect(updateRun(paths, { currentIteration: 1 })).rejects.toThrow(
        "No active run",
      );
    });
  });

  test("endRun sets status and releases lock", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const run = await createRun(paths, "plan-1", "claude", 10, "/tmp");
      await acquireLock(paths, run.id);
      await endRun(paths, "completed");
      const loaded = await loadRun(paths);
      expect(loaded!.status).toBe("completed");
      expect(loaded!.endedAt).toBeDefined();
      const lockStatus = await checkLock(paths);
      expect(lockStatus.locked).toBe(false);
    });
  });
});

describe("lock semantics", () => {
  test("acquireLock creates lock file with pid/hostname/runId", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const acquired = await acquireLock(paths, "run-123");
      expect(acquired).toBe(true);
      const status = await checkLock(paths);
      expect(status.locked).toBe(true);
      expect(status.lock!.pid).toBe(process.pid);
      expect(status.lock!.hostname).toBe(hostname());
      expect(status.lock!.runId).toBe("run-123");
    });
  });

  test("acquireLock returns false when lock already held by running process", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      expect(await acquireLock(paths, "run-1")).toBe(true);
      expect(await acquireLock(paths, "run-2")).toBe(false);
    });
  });

  test("acquireLock cleans stale lock and acquires", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const staleLock: LockFile = {
        pid: 99999999,
        runId: "run-stale",
        acquiredAt: new Date().toISOString(),
        hostname: hostname(),
      };
      await writeJson(paths.lock, staleLock);
      const acquired = await acquireLock(paths, "run-new");
      expect(acquired).toBe(true);
      const status = await checkLock(paths);
      expect(status.lock!.runId).toBe("run-new");
    });
  });

  test("releaseLock removes the file", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      await acquireLock(paths, "run-123");
      await releaseLock(paths);
      const status = await checkLock(paths);
      expect(status.locked).toBe(false);
    });
  });

  test("releaseLock is idempotent", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      await releaseLock(paths);
      await releaseLock(paths);
    });
  });

  test("checkLock returns locked: false when no lock file", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const status = await checkLock(paths);
      expect(status.locked).toBe(false);
      expect(status.stale).toBe(false);
    });
  });

  test("checkLock returns locked: true, stale: false for live PID", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      await acquireLock(paths, "run-live");
      const status = await checkLock(paths);
      expect(status.locked).toBe(true);
      expect(status.stale).toBe(false);
    });
  });

  test("checkLock returns locked: false, stale: true for dead PID", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const staleLock: LockFile = {
        pid: 99999999,
        runId: "run-dead",
        acquiredAt: new Date().toISOString(),
        hostname: hostname(),
      };
      await writeJson(paths.lock, staleLock);
      const status = await checkLock(paths);
      expect(status.locked).toBe(false);
      expect(status.stale).toBe(true);
    });
  });

  test("concurrent acquireLock: only one wins", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const results = await Promise.all([
        acquireLock(paths, "run-a"),
        acquireLock(paths, "run-b"),
      ]);
      const wins = results.filter(Boolean);
      expect(wins).toHaveLength(1);
    });
  });
});
