import { spawn } from "../utils/process.js";

interface CommitGroup {
  prefix: string;
  message: string;
  files: string[];
}

const CATEGORY_PATTERNS: { pattern: RegExp; prefix: string }[] = [
  { pattern: /\.(test|spec)\.(ts|tsx|js|jsx)$/, prefix: "test" },
  { pattern: /\.(md|txt|rst)$/, prefix: "docs" },
  { pattern: /\.(css|scss|less|styled)/, prefix: "style" },
  { pattern: /(config|\.config|tsconfig|eslint|prettier)/, prefix: "chore" },
  { pattern: /migration/, prefix: "refactor" },
];

export function categorizeFile(filepath: string): string {
  for (const { pattern, prefix } of CATEGORY_PATTERNS) {
    if (pattern.test(filepath)) return prefix;
  }
  return "feat";
}

export async function analyzeAndSplit(
  cwd: string,
  description: string,
): Promise<CommitGroup[]> {
  // Get changed files
  const handle = spawn({
    cmd: ["git", "diff", "--cached", "--name-only"],
    cwd,
  });
  const result = await handle.promise;

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return [];
  }

  const files = result.stdout.trim().split("\n");
  const groups = new Map<string, string[]>();

  for (const file of files) {
    const category = categorizeFile(file);
    const existing = groups.get(category) ?? [];
    existing.push(file);
    groups.set(category, existing);
  }

  return Array.from(groups.entries()).map(([prefix, groupFiles]) => ({
    prefix,
    message: `${prefix}: ${description}`,
    files: groupFiles,
  }));
}

export async function splitCommit(
  cwd: string,
  groups: CommitGroup[],
): Promise<void> {
  // Reset staged changes first
  const resetHandle = spawn({ cmd: ["git", "reset", "HEAD"], cwd });
  const resetResult = await resetHandle.promise;
  if (resetResult.exitCode !== 0) {
    throw new Error(`git reset failed (exit ${resetResult.exitCode}): ${resetResult.stderr}`);
  }

  for (const group of groups) {
    const addHandle = spawn({
      cmd: ["git", "add", ...group.files],
      cwd,
    });
    const addResult = await addHandle.promise;
    if (addResult.exitCode !== 0) {
      throw new Error(`git add failed for [${group.files.join(", ")}] (exit ${addResult.exitCode}): ${addResult.stderr}`);
    }

    const commitHandle = spawn({
      cmd: ["git", "commit", "-m", group.message],
      cwd,
    });
    const commitResult = await commitHandle.promise;
    if (commitResult.exitCode !== 0) {
      throw new Error(`git commit failed for "${group.message}" (exit ${commitResult.exitCode}): ${commitResult.stderr}`);
    }
  }
}
