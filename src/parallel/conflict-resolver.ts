import { randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "../utils/process.js";
import type { AgentAdapter } from "../agents/types.js";
import type { MergeOperation } from "./merge-engine.js";
import type { AiAgent, ConflictInfo } from "./ai-resolver.js";
import { resolveWithAi } from "./ai-resolver.js";

export interface ConflictResolutionResult {
  resolved: boolean;
  resolvedCount: number;
  failedCount: number;
}

const MAX_CONFLICTED_FILES = 10;

export function wrapAgentAsAiAgent(agent: AgentAdapter): AiAgent {
  return {
    async resolve(prompt: string, cwd: string): Promise<string> {
      const handle = agent.execute(prompt, { cwd, skipPermissions: true });
      const result = await handle.promise;
      if (result.exitCode !== 0) {
        throw new Error(`Agent failed with exit code ${result.exitCode}: ${result.stderr}`);
      }
      return result.stdout;
    },
  };
}

async function getStageContent(
  file: string,
  stage: number,
  cwd: string,
): Promise<string> {
  const handle = spawn({
    cmd: ["git", "show", `:${stage}:${file}`],
    cwd,
  });
  const result = await handle.promise;
  if (result.exitCode !== 0) {
    return "";
  }
  return result.stdout;
}

async function getConflictInfo(
  file: string,
  taskId: string,
  taskTitle: string,
  cwd: string,
): Promise<ConflictInfo> {
  const [base, ours, theirs] = await Promise.all([
    getStageContent(file, 1, cwd),
    getStageContent(file, 2, cwd),
    getStageContent(file, 3, cwd),
  ]);
  return { file, base, ours, theirs, taskId, taskTitle };
}

async function stageResolvedFile(file: string, content: string, cwd: string): Promise<void> {
  // Write content to a temp file, then hash it into git's object store
  const tmpPath = join(tmpdir(), `synth-resolve-${Date.now()}-${randomBytes(4).toString('hex')}`);
  writeFileSync(tmpPath, content);

  let hashResult;
  try {
    const hashHandle = spawn({
      cmd: ["git", "hash-object", "-w", tmpPath],
      cwd,
    });
    hashResult = await hashHandle.promise;
  } finally {
    unlinkSync(tmpPath);
  }

  if (hashResult.exitCode !== 0) {
    throw new Error(`Failed to hash resolved content for ${file}: ${hashResult.stderr}`);
  }
  const blobHash = hashResult.stdout.trim();

  // Get the file mode from the index (use stage 2 = ours)
  const lsHandle = spawn({
    cmd: ["git", "ls-files", "--stage", file],
    cwd,
  });
  const lsResult = await lsHandle.promise;
  const mode = lsResult.exitCode === 0 && lsResult.stdout.trim()
    ? (lsResult.stdout.trim().split("\t")[0]?.split(" ")[0] || "100644")
    : "100644";

  // Update the index to resolve the conflict
  const updateHandle = spawn({
    cmd: ["git", "update-index", "--cacheinfo", `${mode},${blobHash},${file}`],
    cwd,
  });
  const updateResult = await updateHandle.promise;
  if (updateResult.exitCode !== 0) {
    throw new Error(`Failed to stage resolved file ${file}: ${updateResult.stderr}`);
  }

  // Write the resolved content to the working tree
  writeFileSync(join(cwd, file), content);
}

export async function resolveConflicts(
  operation: MergeOperation,
  repoRoot: string,
  agent: AgentAdapter,
): Promise<ConflictResolutionResult> {
  const files = operation.conflictedFiles ?? [];

  if (files.length === 0) {
    return { resolved: false, resolvedCount: 0, failedCount: 0 };
  }

  // Confidence gating: skip if too many conflicted files
  if (files.length > MAX_CONFLICTED_FILES) {
    return { resolved: false, resolvedCount: 0, failedCount: files.length };
  }

  // Re-start the merge in squash mode so we can resolve in-place
  const mergeHandle = spawn({
    cmd: ["git", "merge", "--squash", operation.sourceBranch],
    cwd: repoRoot,
  });
  const mergeResult = await mergeHandle.promise;

  // merge exits non-zero when there are conflicts (exit code 1), which is expected.
  // If it fails for other reasons, bail out.
  // Squash merge doesn't set MERGE_HEAD, so use reset --hard instead of merge --abort.
  if (mergeResult.exitCode !== 0 && mergeResult.exitCode !== 1) {
    await spawn({ cmd: ["git", "reset", "--hard", "HEAD"], cwd: repoRoot }).promise;
    return { resolved: false, resolvedCount: 0, failedCount: files.length };
  }

  const aiAgent = wrapAgentAsAiAgent(agent);
  let resolvedCount = 0;
  let failedCount = 0;

  for (const file of files) {
    try {
      const conflictInfo = await getConflictInfo(
        file,
        operation.taskId,
        operation.taskTitle,
        repoRoot,
      );

      const resolvedContent = await resolveWithAi(conflictInfo, aiAgent, repoRoot);

      if (resolvedContent !== null) {
        await stageResolvedFile(file, resolvedContent, repoRoot);
        resolvedCount++;
      } else {
        failedCount++;
      }
    } catch {
      failedCount++;
    }
  }

  if (failedCount > 0) {
    await spawn({ cmd: ["git", "reset", "--hard", "HEAD"], cwd: repoRoot }).promise;
    return { resolved: false, resolvedCount, failedCount };
  }

  // Validate that the AI agent only modified the expected conflicted files
  const allowlist = new Set(files);

  const diffUnstagedHandle = spawn({
    cmd: ["git", "diff", "--name-only"],
    cwd: repoRoot,
  });
  const diffStagedHandle = spawn({
    cmd: ["git", "diff", "--name-only", "--cached", "HEAD"],
    cwd: repoRoot,
  });
  const [diffUnstagedResult, diffStagedResult] = await Promise.all([
    diffUnstagedHandle.promise,
    diffStagedHandle.promise,
  ]);

  const changedFiles = new Set<string>();
  for (const output of [diffUnstagedResult.stdout, diffStagedResult.stdout]) {
    for (const line of output.trim().split("\n")) {
      if (line) changedFiles.add(line);
    }
  }

  const unexpectedFiles = Array.from(changedFiles).filter((f) => !allowlist.has(f));
  if (unexpectedFiles.length > 0) {
    console.warn(
      `[conflict-resolver] AI agent modified unexpected files: ${unexpectedFiles.join(", ")}. Reverting.`,
    );
    for (const file of unexpectedFiles) {
      await spawn({ cmd: ["git", "checkout", "HEAD", "--", file], cwd: repoRoot }).promise;
    }
  }

  // All files resolved — commit the squash merge
  const commitHandle = spawn({
    cmd: [
      "git",
      "commit",
      "-m",
      `feat(${operation.taskId}): ${operation.taskTitle} (AI-resolved conflicts)`,
    ],
    cwd: repoRoot,
  });
  const commitResult = await commitHandle.promise;

  if (commitResult.exitCode !== 0) {
    await spawn({ cmd: ["git", "reset", "--hard", "HEAD"], cwd: repoRoot }).promise;
    return { resolved: false, resolvedCount, failedCount: files.length };
  }

  return { resolved: true, resolvedCount, failedCount: 0 };
}
