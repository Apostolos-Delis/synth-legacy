import { describe, test, expect } from "bun:test";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  createRun,
  loadRun,
  updateRun,
  endRun,
  acquireLock,
  releaseLock,
  checkLock,
} from "../run/run.js";
import { writeJson, readJson } from "../utils/fs.js";
import { makeSessionPaths, withTmpDir } from "./helpers.js";
import type { LockFile } from "../run/types.js";
import type { SessionMetadata, SessionPaths } from "../sessions/types.js";

describe("run lifecycle", () => {
  test("createRun writes run.json with correct structure", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const run = await createRun(paths, "plan-1", "claude", 10, "/tmp");
      expect(run.id).toMatch(/^run-/);
      expect(run.sessionId).toBe("plan-1");
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
      expect(loaded!.sessionId).toBe("plan-1");
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

describe("SessionPaths review fields", () => {
  const reviewFields: (keyof SessionPaths)[] = [
    "reviewRoot",
    "reviewFindings",
    "reviewTasks",
    "reviewProgress",
    "reviewConversation",
  ];

  test("all review fields exist on SessionPaths", () => {
    const paths = makeSessionPaths("/fake/root");
    for (const field of reviewFields) {
      expect(paths[field]).toBeDefined();
      expect(typeof paths[field]).toBe("string");
    }
  });

  test("review fields point to review/ subdirectory", () => {
    const paths = makeSessionPaths("/fake/root");
    const expectedReviewRoot = join("/fake/root", "review");

    expect(paths.reviewRoot).toBe(expectedReviewRoot);
    expect(paths.reviewFindings).toBe(join(expectedReviewRoot, "findings.md"));
    expect(paths.reviewTasks).toBe(join(expectedReviewRoot, "tasks.json"));
    expect(paths.reviewProgress).toBe(join(expectedReviewRoot, "progress.md"));
    expect(paths.reviewConversation).toBe(join(expectedReviewRoot, "conversation.json"));
  });

  test("review paths are nested under session root", () => {
    const paths = makeSessionPaths("/some/session");
    for (const field of reviewFields) {
      expect(paths[field].startsWith(paths.root)).toBe(true);
    }
  });
});

describe("makeSessionPaths review paths", () => {
  test("includes all review path keys", () => {
    const paths = makeSessionPaths("/tmp/test-session");
    expect(paths).toHaveProperty("reviewRoot");
    expect(paths).toHaveProperty("reviewFindings");
    expect(paths).toHaveProperty("reviewTasks");
    expect(paths).toHaveProperty("reviewProgress");
    expect(paths).toHaveProperty("reviewConversation");
  });

  test("review paths are consistent across calls with same root", () => {
    const a = makeSessionPaths("/tmp/session-a");
    const b = makeSessionPaths("/tmp/session-a");
    expect(a.reviewRoot).toBe(b.reviewRoot);
    expect(a.reviewFindings).toBe(b.reviewFindings);
    expect(a.reviewTasks).toBe(b.reviewTasks);
    expect(a.reviewProgress).toBe(b.reviewProgress);
    expect(a.reviewConversation).toBe(b.reviewConversation);
  });
});

describe("reviewing session status", () => {
  test("'reviewing' can be written and read back as session metadata status", async () => {
    await withTmpDir(async (dir) => {
      const metaPath = join(dir, "metadata.json");
      const metadata: SessionMetadata = {
        id: "test-session",
        repoKey: "test/repo",
        description: "test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "reviewing",
        taskCount: 5,
        tasksCompleted: 5,
      };

      await writeJson(metaPath, metadata);
      const loaded = await readJson<SessionMetadata>(metaPath);

      expect(loaded.status).toBe("reviewing");
    });
  });

  test("metadata can transition from executing to reviewing", async () => {
    await withTmpDir(async (dir) => {
      const metaPath = join(dir, "metadata.json");
      const initial: SessionMetadata = {
        id: "test-session",
        repoKey: "test/repo",
        description: "test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "executing",
        taskCount: 3,
        tasksCompleted: 3,
      };

      await writeJson(metaPath, initial);

      // Simulate what updateSessionMetadata does internally
      const loaded = await readJson<SessionMetadata>(metaPath);
      const updated: SessionMetadata = {
        ...loaded,
        status: "reviewing",
        updatedAt: new Date().toISOString(),
      };
      await writeJson(metaPath, updated);

      const final = await readJson<SessionMetadata>(metaPath);
      expect(final.status).toBe("reviewing");
      expect(new Date(final.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(initial.updatedAt).getTime(),
      );
    });
  });
});
