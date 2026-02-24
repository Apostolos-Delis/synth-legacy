import { join, dirname } from "node:path";
import { rm, rmdir } from "node:fs/promises";
import { spawn } from "../utils/process.js";
import { dirExists } from "../utils/fs.js";

export interface WorktreeInfo {
  workerId: string;
  taskId: string;
  path: string;
  branch: string;
}

export interface WorktreeManagerOptions {
  repoRoot: string;
  project: string;
  maxWorktrees?: number;
}

const MIN_DISK_MB = 500;

export function sanitizeBranchName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9\-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function worktreeBasePath(repoRoot: string, project: string): string {
  return join(dirname(repoRoot), ".synth-worktrees", project);
}

function workerPath(base: string, workerId: string): string {
  return join(base, `worker-${workerId}`);
}

export class WorktreeManager {
  private readonly repoRoot: string;
  private readonly project: string;
  private readonly maxWorktrees: number;
  private readonly active = new Map<string, WorktreeInfo>();

  constructor(options: WorktreeManagerOptions) {
    this.repoRoot = options.repoRoot;
    this.project = options.project;
    this.maxWorktrees = options.maxWorktrees ?? 8;
  }

  async checkDiskSpace(): Promise<void> {
    const handle = spawn({
      cmd: ["df", "-m", this.repoRoot],
      cwd: this.repoRoot,
    });
    const result = await handle.promise;
    if (result.exitCode !== 0) {
      throw new Error(`Failed to check disk space: ${result.stderr}`);
    }
    // Parse the "Available" column from df output (second line)
    const lines = result.stdout.trim().split("\n");
    if (lines.length < 2) {
      throw new Error("Unexpected df output format");
    }
    const columns = lines[1].split(/\s+/);
    // df -m columns: Filesystem, 1M-blocks, Used, Available, Use%, Mounted on
    const availableMb = parseInt(columns[3], 10);
    if (isNaN(availableMb) || availableMb < MIN_DISK_MB) {
      throw new Error("Insufficient disk space");
    }
  }

  async acquire(
    workerId: string,
    taskId: string,
    sessionBranch: string,
  ): Promise<WorktreeInfo> {
    if (this.active.size >= this.maxWorktrees) {
      throw new Error("Maximum worktrees reached");
    }

    await this.checkDiskSpace();

    const base = worktreeBasePath(this.repoRoot, this.project);
    const wtPath = workerPath(base, workerId);
    const branch = `synth-parallel/${sanitizeBranchName(taskId)}`;

    // Clean up stale worktree at target path
    if (await dirExists(wtPath)) {
      await this.removeWorktree(wtPath, branch);
    }

    const addHandle = spawn({
      cmd: ["git", "worktree", "add", "-b", branch, wtPath, sessionBranch],
      cwd: this.repoRoot,
    });
    const addResult = await addHandle.promise;
    if (addResult.exitCode !== 0) {
      throw new Error(`Failed to create worktree: ${addResult.stderr}`);
    }

    const info: WorktreeInfo = { workerId, taskId, path: wtPath, branch };
    this.active.set(workerId, info);
    return info;
  }

  async release(workerId: string): Promise<void> {
    const info = this.active.get(workerId);
    if (!info) return;

    await this.removeWorktree(info.path, info.branch);
    this.active.delete(workerId);
  }

  async cleanupAll(): Promise<void> {
    const entries = [...this.active.values()];
    for (const info of entries) {
      await this.removeWorktree(info.path, info.branch);
    }
    this.active.clear();

    // Remove base directory if empty
    const base = worktreeBasePath(this.repoRoot, this.project);
    if (await dirExists(base)) {
      try {
        await rmdir(base);
      } catch {
        // Directory not empty or already gone — fine
      }
    }
  }

  async cleanupOrphanedWorktrees(): Promise<void> {
    const handle = spawn({
      cmd: ["git", "worktree", "list", "--porcelain"],
      cwd: this.repoRoot,
    });
    const result = await handle.promise;
    if (result.exitCode !== 0) return;

    const base = worktreeBasePath(this.repoRoot, this.project);
    const blocks = result.stdout.split("\n\n").filter(Boolean);

    for (const block of blocks) {
      const pathMatch = block.match(/^worktree (.+)$/m);
      const branchMatch = block.match(/^branch refs\/heads\/(.+)$/m);
      if (!pathMatch || !branchMatch) continue;

      const wtPath = pathMatch[1];
      const branch = branchMatch[1];

      // Only clean up worktrees under our managed base path
      if (!wtPath.startsWith(base)) continue;
      // Skip if currently tracked as active
      const isActive = [...this.active.values()].some(
        (i) => i.path === wtPath,
      );
      if (isActive) continue;

      await this.removeWorktree(wtPath, branch);
    }
  }

  getActive(): ReadonlyMap<string, WorktreeInfo> {
    return this.active;
  }

  private async removeWorktree(wtPath: string, branch: string): Promise<void> {
    // Force-remove the worktree via git
    const removeHandle = spawn({
      cmd: ["git", "worktree", "remove", "--force", wtPath],
      cwd: this.repoRoot,
    });
    await removeHandle.promise;

    // If git worktree remove failed (e.g. not registered), clean up directory manually
    if (await dirExists(wtPath)) {
      await rm(wtPath, { recursive: true, force: true });
    }

    // Prune stale worktree entries
    const pruneHandle = spawn({
      cmd: ["git", "worktree", "prune"],
      cwd: this.repoRoot,
    });
    await pruneHandle.promise;

    // Delete the branch
    const branchHandle = spawn({
      cmd: ["git", "branch", "-D", branch],
      cwd: this.repoRoot,
    });
    await branchHandle.promise;
  }
}
