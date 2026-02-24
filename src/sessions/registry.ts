import { join, basename } from "node:path";
import { homedir } from "node:os";
import { readdir, rename, rm } from "node:fs/promises";
import type { SessionMetadata, SessionPaths } from "./types.js";
import { generateSessionId } from "./id.js";
import { ensureDir, fileExists, dirExists, readJson, writeJson } from "../utils/fs.js";
import { spawn } from "../utils/process.js";

const SYNTH_HOME = join(homedir(), ".synth");
const LEGACY_PLANS_DIR = join(SYNTH_HOME, "plans");
const SESSIONS_DIR = join(SYNTH_HOME, "sessions");

let migrationDone: Promise<void> | null = null;

export async function migrateStorageAt(
  legacyPlansDir: string,
  sessionsDir: string,
): Promise<void> {
  const plansExist = await dirExists(legacyPlansDir);
  const sessionsExist = await dirExists(sessionsDir);

  if (!plansExist && !sessionsExist) return;

  if (plansExist && !sessionsExist) {
    await rename(legacyPlansDir, sessionsDir);
    console.error(`[synth] Migrated ${legacyPlansDir} → ${sessionsDir}`);
  } else if (plansExist && sessionsExist) {
    let skippedCount = 0;
    const entries = await readdir(legacyPlansDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const src = join(legacyPlansDir, entry.name);
      const dest = join(sessionsDir, entry.name);
      if (await dirExists(dest)) {
        // Merge: copy subdirectories (session IDs) that don't already exist
        const subEntries = await readdir(src, { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isDirectory()) continue;
          const subSrc = join(src, sub.name);
          const subDest = join(dest, sub.name);
          if (!(await dirExists(subDest))) {
            await rename(subSrc, subDest);
            console.error(`[synth] Merged session ${entry.name}/${sub.name} → ${sessionsDir}`);
          } else {
            console.error(`warn: skipping migration of ${entry.name}/${sub.name} — already exists in sessions/`);
            skippedCount++;
          }
        }
      } else {
        await rename(src, dest);
        console.error(`[synth] Merged repo ${entry.name} → ${sessionsDir}`);
      }
    }
    // Clean up legacy dir only if no entries were skipped
    if (skippedCount === 0) {
      try {
        await rm(legacyPlansDir, { recursive: true });
        console.error(`[synth] Removed empty legacy directory ${legacyPlansDir}`);
      } catch {
        // Not empty or already gone — fine
      }
    } else {
      console.error(`[synth] ${skippedCount} entries skipped during migration. Please manually resolve the remaining entries in ${legacyPlansDir}`);
    }
  }

  // Rename session.json → run.json in all session directories
  if (await dirExists(sessionsDir)) {
    const repos = await readdir(sessionsDir, { withFileTypes: true });
    for (const repo of repos) {
      if (!repo.isDirectory()) continue;
      const repoDir = join(sessionsDir, repo.name);
      const sessions = await readdir(repoDir, { withFileTypes: true });
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const oldFile = join(repoDir, session.name, "session.json");
        const newFile = join(repoDir, session.name, "run.json");
        if ((await fileExists(oldFile)) && !(await fileExists(newFile))) {
          await rename(oldFile, newFile);
          console.error(`[synth] Renamed ${repo.name}/${session.name}/session.json → run.json`);
        }
      }
    }
  }
}

async function migrateStorage(): Promise<void> {
  return migrateStorageAt(LEGACY_PLANS_DIR, SESSIONS_DIR);
}

function ensureMigration(): Promise<void> {
  if (!migrationDone) {
    migrationDone = migrateStorage().catch((err) => {
      migrationDone = null;
      throw err;
    });
  }
  return migrationDone;
}

async function getRepoKey(cwd: string): Promise<string> {
  // Try git remote origin
  const result = spawn({
    cmd: ["git", "remote", "get-url", "origin"],
    cwd,
  });
  const { stdout, exitCode } = await result.promise;

  if (exitCode === 0 && stdout.trim()) {
    // Normalize: strip .git, protocol, lowercase
    return stdout
      .trim()
      .replace(/\.git$/, "")
      .replace(/^(https?:\/\/|git@|ssh:\/\/)/, "")
      .replace(":", "/")
      .toLowerCase()
      .split("/")
      .slice(-2)
      .join("/");
  }

  // Fallback: directory name
  return basename(cwd) || "unknown";
}

function sessionPaths(repoKey: string, sessionId: string): SessionPaths {
  const root = join(SESSIONS_DIR, repoKey, sessionId);
  const reviewRoot = join(root, "review");
  return {
    root,
    prd: join(root, "prd.md"),
    tasks: join(root, "tasks.json"),
    progress: join(root, "progress.md"),
    run: join(root, "run.json"),
    lock: join(root, "synth.lock"),
    logs: join(root, "logs"),
    summary: join(root, "summary.md"),
    interview: join(root, "interview.json"),
    reviewRoot,
    reviewFindings: join(reviewRoot, "findings.md"),
    reviewTasks: join(reviewRoot, "tasks.json"),
    reviewProgress: join(reviewRoot, "progress.md"),
    reviewConversation: join(reviewRoot, "conversation.json"),
  };
}

export async function createSession(
  cwd: string,
  description: string,
): Promise<{ id: string; paths: SessionPaths; metadata: SessionMetadata }> {
  await ensureMigration();
  const repoKey = await getRepoKey(cwd);
  const id = generateSessionId();
  const paths = sessionPaths(repoKey, id);

  await ensureDir(paths.root);
  await ensureDir(paths.logs);

  const now = new Date().toISOString();
  const metadata: SessionMetadata = {
    id,
    repoKey,
    description,
    createdAt: now,
    updatedAt: now,
    status: "interviewing",
    taskCount: 0,
    tasksCompleted: 0,
  };

  await writeJson(join(paths.root, "metadata.json"), metadata);

  return { id, paths, metadata };
}

export async function getSession(
  cwd: string,
  sessionId: string,
): Promise<{ paths: SessionPaths; metadata: SessionMetadata } | null> {
  await ensureMigration();
  const repoKey = await getRepoKey(cwd);
  const paths = sessionPaths(repoKey, sessionId);
  const metaPath = join(paths.root, "metadata.json");

  if (!(await fileExists(metaPath))) return null;

  const metadata = await readJson<SessionMetadata>(metaPath);
  return { paths, metadata };
}

export async function updateSessionMetadata(
  cwd: string,
  sessionId: string,
  updates: Partial<SessionMetadata>,
): Promise<SessionMetadata> {
  const session = await getSession(cwd, sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const updated: SessionMetadata = {
    ...session.metadata,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await writeJson(join(session.paths.root, "metadata.json"), updated);
  return updated;
}

export async function listSessions(cwd: string): Promise<SessionMetadata[]> {
  await ensureMigration();
  const repoKey = await getRepoKey(cwd);
  const repoDir = join(SESSIONS_DIR, repoKey);

  if (!(await dirExists(repoDir))) return [];

  const entries = await readdir(repoDir, { withFileTypes: true });
  const sessions: SessionMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(repoDir, entry.name, "metadata.json");
    if (await fileExists(metaPath)) {
      sessions.push(await readJson<SessionMetadata>(metaPath));
    }
  }

  // Sort by most recent first
  sessions.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return sessions;
}

export async function getMostRecentSession(
  cwd: string,
): Promise<{ paths: SessionPaths; metadata: SessionMetadata } | null> {
  const sessions = await listSessions(cwd);
  if (sessions.length === 0) return null;
  return getSession(cwd, sessions[0].id);
}

export async function listAllSessions(): Promise<SessionMetadata[]> {
  await ensureMigration();
  if (!(await dirExists(SESSIONS_DIR))) return [];

  const repos = await readdir(SESSIONS_DIR, { withFileTypes: true });
  const sessions: SessionMetadata[] = [];

  for (const repo of repos) {
    if (!repo.isDirectory()) continue;
    const repoDir = join(SESSIONS_DIR, repo.name);
    const entries = await readdir(repoDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(repoDir, entry.name, "metadata.json");
      if (await fileExists(metaPath)) {
        sessions.push(await readJson<SessionMetadata>(metaPath));
      }
    }
  }

  sessions.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return sessions;
}

export async function deleteSession(cwd: string, sessionId: string): Promise<boolean> {
  await ensureMigration();
  const repoKey = await getRepoKey(cwd);
  const paths = sessionPaths(repoKey, sessionId);
  if (!(await dirExists(paths.root))) return false;
  await rm(paths.root, { recursive: true, force: true });
  return true;
}
