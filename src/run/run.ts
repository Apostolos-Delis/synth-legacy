import { hostname } from "node:os";
import { open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { LockFile, RunMetadata, RunState } from "./types.js";
import type { SessionPaths } from "../sessions/types.js";
import { ensureDir, fileExists, readJson, writeJson } from "../utils/fs.js";
import { isProcessRunning } from "../utils/process.js";

function generateRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createRun(
  sessionPaths: SessionPaths,
  planId: string,
  agent: string,
  maxIterations: number,
  cwd: string,
): Promise<RunMetadata> {
  const run: RunMetadata = {
    id: generateRunId(),
    planId,
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    agent,
    currentIteration: 0,
    maxIterations,
    cwd,
  };

  await writeJson(sessionPaths.run, run);
  return run;
}

export async function loadRun(
  sessionPaths: SessionPaths,
): Promise<RunMetadata | null> {
  if (!(await fileExists(sessionPaths.run))) return null;
  return readJson<RunMetadata>(sessionPaths.run);
}

export async function updateRun(
  sessionPaths: SessionPaths,
  updates: Partial<RunMetadata>,
): Promise<RunMetadata> {
  const run = await loadRun(sessionPaths);
  if (!run) throw new Error("No active run");

  const updated: RunMetadata = {
    ...run,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(sessionPaths.run, updated);
  return updated;
}

export async function endRun(
  sessionPaths: SessionPaths,
  status: RunState = "completed",
): Promise<void> {
  const run = await loadRun(sessionPaths);
  if (run) {
    await updateRun(sessionPaths, {
      status,
      endedAt: new Date().toISOString(),
    });
  }
  await releaseLock(sessionPaths);
}

export async function acquireLock(
  sessionPaths: SessionPaths,
  runId: string,
): Promise<boolean> {
  await ensureDir(dirname(sessionPaths.lock));

  // Check for existing lock and clean stale ones
  if (await fileExists(sessionPaths.lock)) {
    try {
      const existing = await readJson<LockFile>(sessionPaths.lock);
      if (isProcessRunning(existing.pid)) {
        return false; // Another run is actively running
      }
      // Stale lock — remove it before attempting atomic create
      await unlink(sessionPaths.lock);
    } catch {
      // Lock file is corrupt or disappeared — proceed with atomic create
    }
  }

  const lock: LockFile = {
    pid: process.pid,
    runId,
    acquiredAt: new Date().toISOString(),
    hostname: hostname(),
  };

  // Atomic create: O_CREAT|O_EXCL fails if file already exists
  try {
    const fd = await open(sessionPaths.lock, "wx");
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

export async function releaseLock(sessionPaths: SessionPaths): Promise<void> {
  try {
    await unlink(sessionPaths.lock);
  } catch {
    // Lock already removed or doesn't exist
  }
}

export async function checkLock(
  sessionPaths: SessionPaths,
): Promise<{ locked: boolean; stale: boolean; lock?: LockFile }> {
  if (!(await fileExists(sessionPaths.lock))) {
    return { locked: false, stale: false };
  }

  const lock = await readJson<LockFile>(sessionPaths.lock);
  const running = isProcessRunning(lock.pid);

  return { locked: running, stale: !running, lock };
}
