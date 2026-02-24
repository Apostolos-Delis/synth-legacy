import { spawn } from "../utils/process.js";

export interface WorkerResult {
  workerId: string;
  taskId: string;
  taskTitle: string;
  branch: string;
  success?: boolean;
  iterationsRun?: number;
  durationMs?: number;
  commitCount?: number;
  worktreePath?: string;
  error?: string;
}

export interface MergeOperation {
  id: string;
  taskId: string;
  taskTitle: string;
  sourceBranch: string;
  status: "queued" | "in_progress" | "completed" | "failed" | "conflicted";
  backupTag?: string;
  error?: string;
  conflictedFiles?: string[];
}

export interface MergeEngineOptions {
  repoRoot: string;
}

export class MergeEngine {
  private readonly repoRoot: string;
  private readonly operations: MergeOperation[] = [];
  private sessionBranch: string | null = null;
  private nextOperationId = 0;

  constructor(options: MergeEngineOptions) {
    this.repoRoot = options.repoRoot;
  }

  async initializeSessionBranch(sessionId: string): Promise<string> {
    const shortId = sessionId.slice(0, 8);
    const branch = `synth-session/${shortId}`;

    const handle = spawn({
      cmd: ["git", "checkout", "-b", branch],
      cwd: this.repoRoot,
    });
    const result = await handle.promise;
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create session branch: ${result.stderr}`);
    }

    this.sessionBranch = branch;
    return branch;
  }

  enqueue(workerResult: WorkerResult): MergeOperation {
    this.nextOperationId++;
    const operation: MergeOperation = {
      id: `merge-${this.nextOperationId}`,
      taskId: workerResult.taskId,
      taskTitle: workerResult.taskTitle,
      sourceBranch: workerResult.branch,
      status: "queued",
    };
    this.operations.push(operation);
    return operation;
  }

  async processNext(): Promise<MergeOperation | null> {
    const operation = this.operations.find((op) => op.status === "queued");
    if (!operation) return null;

    operation.status = "in_progress";

    // Check if source branch has commits ahead of HEAD
    const logHandle = spawn({
      cmd: ["git", "log", `HEAD..${operation.sourceBranch}`, "--oneline"],
      cwd: this.repoRoot,
    });
    const logResult = await logHandle.promise;
    if (logResult.exitCode !== 0) {
      operation.status = "failed";
      operation.error = `Failed to check source branch: ${logResult.stderr}`;
      return operation;
    }
    if (logResult.stdout.trim() === "") {
      operation.status = "failed";
      operation.error = "No commits to merge";
      return operation;
    }

    // Create backup tag before merge
    const timestamp = Date.now();
    const backupTag = `synth/pre-merge/${operation.taskId}/${timestamp}`;
    operation.backupTag = backupTag;

    const tagHandle = spawn({
      cmd: ["git", "tag", backupTag, "HEAD"],
      cwd: this.repoRoot,
    });
    const tagResult = await tagHandle.promise;
    if (tagResult.exitCode !== 0) {
      operation.status = "failed";
      operation.error = `Failed to create backup tag: ${tagResult.stderr}`;
      return operation;
    }

    // Squash merge: collapses all branch commits into staged changes
    const squashHandle = spawn({
      cmd: ["git", "merge", "--squash", operation.sourceBranch],
      cwd: this.repoRoot,
    });
    const squashResult = await squashHandle.promise;

    if (squashResult.exitCode !== 0) {
      // Conflict: extract conflicted file paths and reset to backup
      // (squash merge doesn't set MERGE_HEAD, so use reset --hard instead of merge --abort)
      operation.status = "conflicted";
      operation.error = squashResult.stderr;

      let conflicted = parseConflictedFiles(squashResult.stderr);
      if (conflicted.length === 0) {
        conflicted = await getConflictedFilesFromDiff(this.repoRoot);
      }
      operation.conflictedFiles = conflicted;

      const resetHandle = spawn({
        cmd: ["git", "reset", "--hard", backupTag],
        cwd: this.repoRoot,
      });
      await resetHandle.promise;

      return operation;
    }

    // Check if squash produced any staged changes
    const diffHandle = spawn({
      cmd: ["git", "diff", "--cached", "--quiet"],
      cwd: this.repoRoot,
    });
    const diffResult = await diffHandle.promise;
    if (diffResult.exitCode === 0) {
      // No changes — squash was a no-op
      operation.status = "failed";
      operation.error = "Squash merge produced no changes";
      return operation;
    }

    // Commit the squashed changes
    const commitHandle = spawn({
      cmd: ["git", "commit", "-m", `feat(${operation.taskId}): ${operation.taskTitle}`],
      cwd: this.repoRoot,
    });
    const commitResult = await commitHandle.promise;
    if (commitResult.exitCode !== 0) {
      operation.status = "failed";
      operation.error = `Failed to commit squash: ${commitResult.stderr}`;

      const resetHandle = spawn({
        cmd: ["git", "reset", "--hard", backupTag],
        cwd: this.repoRoot,
      });
      await resetHandle.promise;

      return operation;
    }

    operation.status = "completed";
    return operation;
  }

  async rollbackMerge(operationId: string): Promise<void> {
    const operation = this.operations.find((op) => op.id === operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }
    if (!operation.backupTag) {
      throw new Error(`No backup tag for operation ${operationId}`);
    }

    const handle = spawn({
      cmd: ["git", "reset", "--hard", operation.backupTag],
      cwd: this.repoRoot,
    });
    const result = await handle.promise;
    if (result.exitCode !== 0) {
      throw new Error(`Failed to rollback: ${result.stderr}`);
    }
  }

  getOperations(): readonly MergeOperation[] {
    return this.operations;
  }

  getSessionBranch(): string | null {
    return this.sessionBranch;
  }
}

/** Parse conflicted file paths from git merge stderr output. */
export function parseConflictedFiles(stderr: string): string[] {
  const files: string[] = [];
  for (const line of stderr.split("\n")) {
    const match = line.match(/^CONFLICT\s.*:\s.*(?:in|of)\s+(.+)$/);
    if (match) files.push(match[1].trim());
  }
  return files;
}

/** Reliable fallback: get conflicted files via git diff during an unresolved merge. */
export async function getConflictedFilesFromDiff(
  repoRoot: string,
): Promise<string[]> {
  const handle = spawn({
    cmd: ["git", "diff", "--name-only", "--diff-filter=U"],
    cwd: repoRoot,
  });
  const result = await handle.promise;
  if (result.exitCode !== 0) return [];
  return result.stdout
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}
