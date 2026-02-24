import { spawn } from "./process.js";

export async function getCurrentBranch(cwd: string): Promise<string> {
  const handle = spawn({
    cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    cwd,
  });
  const result = await handle.promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to detect current branch: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function createBranch(
  name: string,
  startPoint: string,
  cwd: string,
): Promise<void> {
  const result = await spawn({
    cmd: ["git", "branch", name, startPoint],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create branch '${name}': ${result.stderr}`);
  }
}

export async function deleteBranch(
  name: string,
  cwd: string,
  force = false,
): Promise<void> {
  const flag = force ? "-D" : "-d";
  const result = await spawn({
    cmd: ["git", "branch", flag, name],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to delete branch '${name}': ${result.stderr}`);
  }
}

export async function checkoutBranch(
  name: string,
  cwd: string,
): Promise<void> {
  const result = await spawn({
    cmd: ["git", "checkout", name],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to checkout branch '${name}': ${result.stderr}`);
  }
}

export async function createTag(name: string, cwd: string): Promise<void> {
  const result = await spawn({
    cmd: ["git", "tag", name],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create tag '${name}': ${result.stderr}`);
  }
}

export async function deleteTag(name: string, cwd: string): Promise<void> {
  const result = await spawn({
    cmd: ["git", "tag", "-d", name],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to delete tag '${name}': ${result.stderr}`);
  }
}

export async function getCommitCount(
  branch1: string,
  branch2: string,
  cwd: string,
): Promise<number> {
  const result = await spawn({
    cmd: ["git", "rev-list", "--count", `${branch1}..${branch2}`],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to get commit count between '${branch1}' and '${branch2}': ${result.stderr}`,
    );
  }
  return parseInt(result.stdout.trim(), 10);
}

export async function mergeFF(branch: string, cwd: string): Promise<void> {
  const result = await spawn({
    cmd: ["git", "merge", "--ff-only", branch],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to fast-forward merge '${branch}': ${result.stderr}`,
    );
  }
}

export async function mergeNoFF(
  branch: string,
  message: string,
  cwd: string,
): Promise<void> {
  const result = await spawn({
    cmd: ["git", "merge", "--no-ff", "-m", message, branch],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to merge '${branch}': ${result.stderr}`);
  }
}

export async function mergeAbort(cwd: string): Promise<void> {
  const result = await spawn({
    cmd: ["git", "merge", "--abort"],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to abort merge: ${result.stderr}`);
  }
}

export async function resetHard(ref: string, cwd: string): Promise<void> {
  const result = await spawn({
    cmd: ["git", "reset", "--hard", ref],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to reset to '${ref}': ${result.stderr}`);
  }
}

export async function addWorktree(
  path: string,
  branch: string,
  cwd: string,
): Promise<void> {
  const result = await spawn({
    cmd: ["git", "worktree", "add", path, branch],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to add worktree at '${path}': ${result.stderr}`,
    );
  }
}

export async function removeWorktree(
  path: string,
  cwd: string,
): Promise<void> {
  const result = await spawn({
    cmd: ["git", "worktree", "remove", "--force", path],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to remove worktree at '${path}': ${result.stderr}`,
    );
  }
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
}

export async function squashMerge(
  branch: string,
  cwd: string,
): Promise<{ exitCode: number; stderr: string }> {
  const result = await spawn({
    cmd: ["git", "merge", "--squash", branch],
    cwd,
  }).promise;
  return { exitCode: result.exitCode, stderr: result.stderr };
}

export async function commitStaged(
  message: string,
  cwd: string,
): Promise<void> {
  const result = await spawn({
    cmd: ["git", "commit", "-m", message],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to commit: ${result.stderr}`);
  }
}

export async function hasStagedChanges(cwd: string): Promise<boolean> {
  const result = await spawn({
    cmd: ["git", "diff", "--cached", "--quiet"],
    cwd,
  }).promise;
  // exit code 0 = no changes, 1 = has changes
  return result.exitCode !== 0;
}

export async function listBranches(
  pattern: string,
  cwd: string,
): Promise<string[]> {
  const result = await spawn({
    cmd: ["git", "branch", "--list", pattern, "--format=%(refname:short)"],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to list branches matching '${pattern}': ${result.stderr}`);
  }
  return result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

export async function listTags(
  pattern: string,
  cwd: string,
): Promise<string[]> {
  const result = await spawn({
    cmd: ["git", "tag", "-l", pattern],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to list tags matching '${pattern}': ${result.stderr}`);
  }
  return result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

export async function gitLog(
  args: string[],
  cwd: string,
): Promise<string> {
  const result = await spawn({
    cmd: ["git", "log", ...args],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to run git log: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const result = await spawn({
    cmd: ["git", "worktree", "list", "--porcelain"],
    cwd,
  }).promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to list worktrees: ${result.stderr}`);
  }

  const blocks = result.stdout.trim().split("\n\n");
  const worktrees: WorktreeInfo[] = [];

  for (const block of blocks) {
    if (!block.trim()) continue;
    const pathMatch = block.match(/^worktree (.+)$/m);
    const headMatch = block.match(/^HEAD ([0-9a-f]+)$/m);
    const branchMatch = block.match(/^branch (.+)$/m);
    if (pathMatch && headMatch) {
      worktrees.push({
        path: pathMatch[1],
        head: headMatch[1],
        branch: branchMatch ? branchMatch[1] : null,
      });
    }
  }

  return worktrees;
}
