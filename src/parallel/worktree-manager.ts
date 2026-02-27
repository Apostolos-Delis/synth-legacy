import { join, dirname } from "node:path";
import { rm, rmdir } from "node:fs/promises";
import { spawn, type SpawnResult } from "../utils/process.js";
import { dirExists } from "../utils/fs.js";
import { getPlatform } from "../platform/index.js";
import { getLogger } from "../logging/logger.js";

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
  private releasedBranches: string[] = [];

  constructor(options: WorktreeManagerOptions) {
    this.repoRoot = options.repoRoot;
    this.project = options.project;
    this.maxWorktrees = options.maxWorktrees ?? 8;
  }

  async checkDiskSpace(): Promise<void> {
    const availableMb = await getPlatform().getAvailableDiskMb(this.repoRoot);
    if (availableMb < MIN_DISK_MB) {
      throw new Error("Insufficient disk space");
    }
  }

  async acquire(
    workerId: string,
    taskId: string,
    sessionBranch: string,
  ): Promise<WorktreeInfo> {
    if (this.active.size >= this.maxWorktrees) {
      // Prune stale git worktree entries and clean up orphans before giving up
      await spawn({ cmd: ["git", "worktree", "prune"], cwd: this.repoRoot }).promise;
      await this.cleanupOrphanedWorktrees();
      if (this.active.size >= this.maxWorktrees) {
        throw new Error("Maximum worktrees reached");
      }
    }

    await this.checkDiskSpace();

    const base = worktreeBasePath(this.repoRoot, this.project);
    const wtPath = workerPath(base, workerId);
    const branch = `synth-parallel/${sanitizeBranchName(taskId)}`;

    // Clean up stale worktree at target path
    if (await dirExists(wtPath)) {
      await this.removeWorktree(wtPath, branch);
    }

    const addResult = await this.tryWorktreeAdd(branch, wtPath, sessionBranch);
    if (addResult.exitCode !== 0) {
      // Retry once on "already exists" — stale branch or worktree entry
      if (addResult.stderr.includes("already exists")) {
        await this.removeWorktree(wtPath, branch);
        const retryResult = await this.tryWorktreeAdd(branch, wtPath, sessionBranch);
        if (retryResult.exitCode !== 0) {
          throw new Error(`Failed to create worktree: ${retryResult.stderr}`);
        }
      } else {
        throw new Error(`Failed to create worktree: ${addResult.stderr}`);
      }
    }

    const info: WorktreeInfo = { workerId, taskId, path: wtPath, branch };
    this.active.set(workerId, info);
    getLogger().info("worktree:create", `Created worktree for task ${taskId}`, {
      taskId,
      workerId,
      branch,
      path: wtPath,
    });
    return info;
  }

  private async tryWorktreeAdd(
    branch: string,
    wtPath: string,
    sessionBranch: string,
  ): Promise<SpawnResult> {
    return spawn({
      cmd: ["git", "worktree", "add", "-b", branch, wtPath, sessionBranch],
      cwd: this.repoRoot,
    }).promise;
  }

  async releaseDirectory(workerId: string): Promise<void> {
    const info = this.active.get(workerId);
    if (!info) return;

    await this.removeWorktreeDir(info.path);

    // Branch must survive for merging — track for later cleanup
    this.releasedBranches.push(info.branch);
    this.active.delete(workerId);
  }

  async release(workerId: string): Promise<void> {
    const info = this.active.get(workerId);
    if (!info) return;

    await this.removeWorktree(info.path, info.branch);
    this.active.delete(workerId);
  }

  async cleanupAll(): Promise<void> {
    const entries = [...this.active.values()];
    const log = getLogger();
    for (const info of entries) {
      log.info("worktree:cleanup", `Cleaning up worktree for task ${info.taskId}`, {
        taskId: info.taskId,
        workerId: info.workerId,
        branch: info.branch,
      });
      await this.removeWorktree(info.path, info.branch, true);
    }
    this.active.clear();

    // Single prune after all removals instead of per-removal
    await spawn({ cmd: ["git", "worktree", "prune"], cwd: this.repoRoot }).promise;

    // Clean up branches from worktrees released via releaseDirectory()
    for (const branch of this.releasedBranches) {
      await spawn({ cmd: ["git", "branch", "-D", branch], cwd: this.repoRoot }).promise;
    }
    this.releasedBranches = [];

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

  dispose(): void {
    if (this.releasedBranches.length > 0) {
      const leaked = this.releasedBranches.join(", ");
      console.warn(`[WorktreeManager] dispose called with uncleaned released branches: ${leaked}`);
    }
    if (this.active.size > 0) {
      const leaked = [...this.active.keys()].join(", ");
      console.warn(`[WorktreeManager] dispose called with active worktrees: ${leaked}`);
    }
  }

  private async removeWorktreeDir(wtPath: string): Promise<void> {
    await spawn({
      cmd: ["git", "worktree", "remove", "--force", wtPath],
      cwd: this.repoRoot,
    }).promise;

    if (await dirExists(wtPath)) {
      await rm(wtPath, { recursive: true, force: true });
    }
  }

  private async removeWorktree(wtPath: string, branch: string, skipPrune = false): Promise<void> {
    await this.removeWorktreeDir(wtPath);

    if (!skipPrune) {
      await spawn({ cmd: ["git", "worktree", "prune"], cwd: this.repoRoot }).promise;
    }
    await spawn({ cmd: ["git", "branch", "-D", branch], cwd: this.repoRoot }).promise;
  }
}
