import { hostname } from "node:os";
import { open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { LockFile, SessionMetadata, SessionState } from "./types.js";
import type { PlanPaths } from "../plans/types.js";
import { ensureDir, fileExists, readJson, writeJson } from "../utils/fs.js";
import { isProcessRunning } from "../utils/process.js";

function generateSessionId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createSession(
  planPaths: PlanPaths,
  planId: string,
  agent: string,
  maxIterations: number,
  cwd: string,
): Promise<SessionMetadata> {
  const session: SessionMetadata = {
    id: generateSessionId(),
    planId,
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    agent,
    currentIteration: 0,
    maxIterations,
    cwd,
  };

  await writeJson(planPaths.session, session);
  return session;
}

export async function loadSession(
  planPaths: PlanPaths,
): Promise<SessionMetadata | null> {
  if (!(await fileExists(planPaths.session))) return null;
  return readJson<SessionMetadata>(planPaths.session);
}

export async function updateSession(
  planPaths: PlanPaths,
  updates: Partial<SessionMetadata>,
): Promise<SessionMetadata> {
  const session = await loadSession(planPaths);
  if (!session) throw new Error("No active session");

  const updated: SessionMetadata = {
    ...session,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(planPaths.session, updated);
  return updated;
}

export async function endSession(
  planPaths: PlanPaths,
  status: SessionState = "completed",
): Promise<void> {
  const session = await loadSession(planPaths);
  if (session) {
    await updateSession(planPaths, {
      status,
      endedAt: new Date().toISOString(),
    });
  }
  await releaseLock(planPaths);
}

export async function acquireLock(
  planPaths: PlanPaths,
  sessionId: string,
): Promise<boolean> {
  await ensureDir(dirname(planPaths.lock));

  // Check for existing lock and clean stale ones
  if (await fileExists(planPaths.lock)) {
    try {
      const existing = await readJson<LockFile>(planPaths.lock);
      if (isProcessRunning(existing.pid)) {
        return false; // Another session is actively running
      }
      // Stale lock — remove it before attempting atomic create
      await unlink(planPaths.lock);
    } catch {
      // Lock file is corrupt or disappeared — proceed with atomic create
    }
  }

  const lock: LockFile = {
    pid: process.pid,
    sessionId,
    acquiredAt: new Date().toISOString(),
    hostname: hostname(),
  };

  // Atomic create: O_CREAT|O_EXCL fails if file already exists
  try {
    const fd = await open(planPaths.lock, "wx");
    await fd.writeFile(JSON.stringify(lock, null, 2) + "\n");
    await fd.close();
    return true;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
      return false; // Another process won the race
    }
    throw err;
  }
}

export async function releaseLock(planPaths: PlanPaths): Promise<void> {
  try {
    await unlink(planPaths.lock);
  } catch {
    // Lock already removed or doesn't exist
  }
}

export async function checkLock(
  planPaths: PlanPaths,
): Promise<{ locked: boolean; stale: boolean; lock?: LockFile }> {
  if (!(await fileExists(planPaths.lock))) {
    return { locked: false, stale: false };
  }

  const lock = await readJson<LockFile>(planPaths.lock);
  const running = isProcessRunning(lock.pid);

  return { locked: running, stale: !running, lock };
}
