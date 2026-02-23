import { join } from "node:path";
import { homedir } from "node:os";
import { readdir, rm } from "node:fs/promises";
import type { SessionMetadata, SessionPaths } from "./types.js";
import { generateSessionId } from "./id.js";
import { ensureDir, fileExists, dirExists, readJson, writeJson } from "../utils/fs.js";
import { spawn } from "../utils/process.js";

const SYNTH_HOME = join(homedir(), ".synth");
const PLANS_DIR = join(SYNTH_HOME, "plans");

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
  return cwd.split("/").pop() ?? "unknown";
}

function sessionPaths(repoKey: string, sessionId: string): SessionPaths {
  const root = join(PLANS_DIR, repoKey, sessionId);
  return {
    root,
    prd: join(root, "prd.md"),
    tasks: join(root, "tasks.json"),
    progress: join(root, "progress.md"),
    session: join(root, "session.json"),
    lock: join(root, "synth.lock"),
    logs: join(root, "logs"),
    summary: join(root, "summary.md"),
    interview: join(root, "interview.json"),
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
  const repoKey = await getRepoKey(cwd);
  const repoDir = join(PLANS_DIR, repoKey);

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

export async function deleteSession(cwd: string, sessionId: string): Promise<boolean> {
  const repoKey = await getRepoKey(cwd);
  const paths = sessionPaths(repoKey, sessionId);
  if (!(await dirExists(paths.root))) return false;
  await rm(paths.root, { recursive: true, force: true });
  return true;
}
