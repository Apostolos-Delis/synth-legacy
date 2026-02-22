import { describe, test, expect } from "bun:test";
import { hostname } from "node:os";
import {
  createSession,
  loadSession,
  updateSession,
  endSession,
  acquireLock,
  releaseLock,
  checkLock,
} from "../session/session.js";
import { writeJson } from "../utils/fs.js";
import { makePlanPaths, withTmpDir } from "./helpers.js";
import type { LockFile } from "../session/types.js";

describe("session lifecycle", () => {
  test("createSession writes session.json with correct structure", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      const session = await createSession(paths, "plan-1", "claude", 10, "/tmp");
      expect(session.id).toMatch(/^sess-/);
      expect(session.planId).toBe("plan-1");
      expect(session.status).toBe("running");
      expect(session.agent).toBe("claude");
      expect(session.currentIteration).toBe(0);
      expect(session.maxIterations).toBe(10);
      expect(session.cwd).toBe("/tmp");
      expect(session.startedAt).toBeDefined();
      expect(session.updatedAt).toBeDefined();
    });
  });

  test("loadSession reads back what was written", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      const created = await createSession(paths, "plan-1", "claude", 10, "/tmp");
      const loaded = await loadSession(paths);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(created.id);
      expect(loaded!.planId).toBe("plan-1");
      expect(loaded!.status).toBe("running");
    });
  });

  test("loadSession returns null when no session exists", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      const session = await loadSession(paths);
      expect(session).toBeNull();
    });
  });

  test("updateSession merges fields and bumps updatedAt", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      const created = await createSession(paths, "plan-1", "claude", 10, "/tmp");
      const updated = await updateSession(paths, { currentIteration: 3 });
      expect(updated.currentIteration).toBe(3);
      expect(updated.id).toBe(created.id);
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updatedAt).getTime(),
      );
    });
  });

  test("updateSession throws when no session exists", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      expect(updateSession(paths, { currentIteration: 1 })).rejects.toThrow(
        "No active session",
      );
    });
  });

  test("endSession sets status and releases lock", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      const session = await createSession(paths, "plan-1", "claude", 10, "/tmp");
      await acquireLock(paths, session.id);
      await endSession(paths, "completed");
      const loaded = await loadSession(paths);
      expect(loaded!.status).toBe("completed");
      expect(loaded!.endedAt).toBeDefined();
      const lockStatus = await checkLock(paths);
      expect(lockStatus.locked).toBe(false);
    });
  });
});

describe("lock semantics", () => {
  test("acquireLock creates lock file with pid/hostname/sessionId", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      const acquired = await acquireLock(paths, "sess-123");
      expect(acquired).toBe(true);
      const status = await checkLock(paths);
      expect(status.locked).toBe(true);
      expect(status.lock!.pid).toBe(process.pid);
      expect(status.lock!.hostname).toBe(hostname());
      expect(status.lock!.sessionId).toBe("sess-123");
    });
  });

  test("acquireLock returns false when lock already held by running process", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      expect(await acquireLock(paths, "sess-1")).toBe(true);
      expect(await acquireLock(paths, "sess-2")).toBe(false);
    });
  });

  test("acquireLock cleans stale lock and acquires", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      const staleLock: LockFile = {
        pid: 99999999,
        sessionId: "sess-stale",
        acquiredAt: new Date().toISOString(),
        hostname: hostname(),
      };
      await writeJson(paths.lock, staleLock);
      const acquired = await acquireLock(paths, "sess-new");
      expect(acquired).toBe(true);
      const status = await checkLock(paths);
      expect(status.lock!.sessionId).toBe("sess-new");
    });
  });

  test("releaseLock removes the file", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      await acquireLock(paths, "sess-123");
      await releaseLock(paths);
      const status = await checkLock(paths);
      expect(status.locked).toBe(false);
    });
  });

  test("releaseLock is idempotent", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      await releaseLock(paths);
      await releaseLock(paths);
    });
  });

  test("checkLock returns locked: false when no lock file", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      const status = await checkLock(paths);
      expect(status.locked).toBe(false);
      expect(status.stale).toBe(false);
    });
  });

  test("checkLock returns locked: true, stale: false for live PID", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      await acquireLock(paths, "sess-live");
      const status = await checkLock(paths);
      expect(status.locked).toBe(true);
      expect(status.stale).toBe(false);
    });
  });

  test("checkLock returns locked: false, stale: true for dead PID", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      const staleLock: LockFile = {
        pid: 99999999,
        sessionId: "sess-dead",
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
      const paths = makePlanPaths(dir);
      const results = await Promise.all([
        acquireLock(paths, "sess-a"),
        acquireLock(paths, "sess-b"),
      ]);
      const wins = results.filter(Boolean);
      expect(wins).toHaveLength(1);
    });
  });
});
