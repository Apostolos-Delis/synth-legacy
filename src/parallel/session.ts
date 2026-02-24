import { join } from "node:path";
import {
  readJson,
  writeJson,
  fileExists,
  removeFile,
} from "../utils/fs.js";
import { listWorktrees, removeWorktree, deleteBranch } from "../utils/git.js";
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
