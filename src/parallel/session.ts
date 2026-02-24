import { join } from "node:path";
import {
  readJson,
  writeJson,
  fileExists,
  removeFile,
} from "../utils/fs.js";
import {
  listWorktrees,
  removeWorktree,
  deleteBranch,
  getCurrentBranch,
  listBranches,
  listTags,
  deleteTag,
  gitLog,
} from "../utils/git.js";
import { loadTasks, saveTasks, updateTaskStatus } from "../tasks/store.js";
import type { Task } from "../tasks/types.js";
import type { TaskGraphNode, ParallelGroup } from "./task-graph.js";
import type { SessionPaths } from "../sessions/types.js";

export interface ParallelSessionState {
  sessionId: string;
  taskGraph: {
    groups: ParallelGroup[];
    cyclicTaskIds: string[];
    maxParallelism: number;
    recommendParallel: boolean;
    nodes: [string, TaskGraphNode][];
  };
  lastCompletedGroupIndex: number;
  mergedTaskIds: string[];
  failedTaskIds: string[];
  requeuedTaskIds: string[];
  sessionStartTag: string;
  sessionBranch: string;
  originalBranch: string;
}

function sessionFilePath(sessionPaths: SessionPaths): string {
  return join(sessionPaths.root, ".synth", "parallel-session.json");
}

export async function saveParallelSession(
  sessionPaths: SessionPaths,
  state: ParallelSessionState,
): Promise<void> {
  await writeJson(sessionFilePath(sessionPaths), state);
}

export async function loadParallelSession(
  sessionPaths: SessionPaths,
): Promise<ParallelSessionState | null> {
  const path = sessionFilePath(sessionPaths);
  if (!(await fileExists(path))) return null;

  const raw = await readJson<ParallelSessionState>(path);

  // Deserialize nodes from array-of-tuples back to Map-compatible format
  // The caller can reconstruct the Map via: new Map(state.taskGraph.nodes)
  return raw;
}

export async function deleteParallelSession(
  sessionPaths: SessionPaths,
): Promise<void> {
  await removeFile(sessionFilePath(sessionPaths));
}

export async function findOrphanedWorktrees(
  projectDir: string,
): Promise<string[]> {
  const worktrees = await listWorktrees(projectDir);
  const orphaned: string[] = [];

  for (const wt of worktrees) {
    if (
      wt.branch &&
      wt.branch.startsWith("refs/heads/synth-parallel/")
    ) {
      orphaned.push(wt.path);
    }
  }

  return orphaned;
}

export async function cleanupOrphanedWorktrees(
  projectDir: string,
): Promise<void> {
  const worktrees = await listWorktrees(projectDir);

  for (const wt of worktrees) {
    if (
      wt.branch &&
      wt.branch.startsWith("refs/heads/synth-parallel/")
    ) {
      const branchName = wt.branch.replace("refs/heads/", "");

      try {
        await removeWorktree(wt.path, projectDir);
      } catch {
        // Worktree may already be gone
      }

      try {
        await deleteBranch(branchName, projectDir, true);
      } catch {
        // Branch may already be deleted
      }
    }
  }
}

export async function cleanupStaleParallelState(
  repoRoot: string,
  sessionPaths: SessionPaths,
): Promise<void> {
  // 1. Clean orphaned worktrees
  await cleanupOrphanedWorktrees(repoRoot);

  // 2. Delete stale synth-session/* branches (except the one we're currently on)
  const currentBranch = await getCurrentBranch(repoRoot);
  const sessionBranches = await listBranches("synth-session/*", repoRoot);
  for (const branch of sessionBranches) {
    if (branch === currentBranch) continue;
    try {
      await deleteBranch(branch, repoRoot, true);
    } catch {
      // Branch may be checked out elsewhere or already deleted
    }
  }

  // 3. Delete stale synth/session-start/* and synth/pre-merge/*/* tags
  const sessionStartTags = await listTags("synth/session-start/*", repoRoot);
  for (const tag of sessionStartTags) {
    try {
      await deleteTag(tag, repoRoot);
    } catch {
      // Tag may already be deleted
    }
  }

  const preMergeTags = await listTags("synth/pre-merge/*/*", repoRoot);
  for (const tag of preMergeTags) {
    try {
      await deleteTag(tag, repoRoot);
    } catch {
      // Tag may already be deleted
    }
  }

  // 4. Delete stale parallel session file
  try {
    await deleteParallelSession(sessionPaths);
  } catch {
    // Session file may not exist
  }
}

export async function reconcileTasksFromGitLog(
  repoRoot: string,
  sessionPaths: SessionPaths,
  tasks: Task[],
): Promise<string[]> {
  const taskIdPattern = /^[a-f0-9]+\s+feat\(([A-Z]+-\d+)\):/;
  let logOutput: string;
  try {
    logOutput = await gitLog(["--oneline"], repoRoot);
  } catch {
    return [];
  }

  if (!logOutput) return [];

  const openTaskIds = new Set(
    tasks.filter((t) => t.status !== "done" && t.status !== "skipped").map((t) => t.id),
  );

  const reconciledIds: string[] = [];
  for (const line of logOutput.split("\n")) {
    const match = line.match(taskIdPattern);
    if (match && openTaskIds.has(match[1])) {
      reconciledIds.push(match[1]);
    }
  }

  if (reconciledIds.length === 0) return [];

  // Update tasks.json for each reconciled task
  let taskFile = await loadTasks(sessionPaths.tasks);
  for (const taskId of reconciledIds) {
    taskFile = updateTaskStatus(taskFile, taskId, "done", "Reconciled from git history after crash recovery");
  }
  await saveTasks(sessionPaths.tasks, taskFile);

  return reconciledIds;
}
