import { join, basename } from "node:path";
import { homedir } from "node:os";
import { readdir, rm } from "node:fs/promises";
import type { SessionMetadata, SessionPaths } from "./types.js";
import { generateSessionId } from "./id.js";
import { ensureDir, fileExists, dirExists, readJson, writeJson } from "../utils/fs.js";
import { spawn } from "../utils/process.js";
import { getLogger, initLogger } from "../logging/logger.js";

const SYNTH_HOME = join(homedir(), ".synth");
const SESSIONS_DIR = join(SYNTH_HOME, "sessions");

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
    sessionLog: join(root, "session.log"),
  };
}

export async function createSession(
  cwd: string,
  description: string,
): Promise<{ id: string; paths: SessionPaths; metadata: SessionMetadata }> {
  const repoKey = await getRepoKey(cwd);
  const id = generateSessionId();
  const paths = sessionPaths(repoKey, id);

  await ensureDir(paths.root);
  await ensureDir(paths.logs);
  initLogger(paths.sessionLog, { context: { request_id: id } });

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

  getLogger().info("session:create", `Created session ${id}`, {
    sessionId: id,
    repoKey,
    description,
  });

  return { id, paths, metadata };
}

export async function getSession(
  cwd: string,
  sessionId: string,
): Promise<{ paths: SessionPaths; metadata: SessionMetadata } | null> {
  const repoKey = await getRepoKey(cwd);
  const paths = sessionPaths(repoKey, sessionId);
  const metaPath = join(paths.root, "metadata.json");

  if (!(await fileExists(metaPath))) return null;

  const metadata = await readJson<SessionMetadata>(metaPath);
  initLogger(paths.sessionLog, { context: { request_id: sessionId } });
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

  if (updates.status && updates.status !== session.metadata.status) {
    getLogger().info(
      "session:status-change",
      `Session ${sessionId} status: ${session.metadata.status} → ${updates.status}`,
      { sessionId, from: session.metadata.status, to: updates.status },
    );
  }

  await writeJson(join(session.paths.root, "metadata.json"), updated);
  return updated;
}

export async function listSessions(cwd: string): Promise<SessionMetadata[]> {
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
  const repoKey = await getRepoKey(cwd);
  const paths = sessionPaths(repoKey, sessionId);
  if (!(await dirExists(paths.root))) return false;
  await rm(paths.root, { recursive: true, force: true });
  return true;
}
