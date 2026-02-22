import { join } from "node:path";
import { homedir } from "node:os";
import { readdir, rm } from "node:fs/promises";
import type { PlanMetadata, PlanPaths } from "./types.js";
import { generatePlanId } from "./id.js";
import { ensureDir, fileExists, dirExists, readJson, writeJson } from "../utils/fs.js";
import { spawn } from "../utils/process.js";

const SYNTH_HOME = join(homedir(), ".synth");
const PLANS_DIR = join(SYNTH_HOME, "plans");

export async function getRepoKey(cwd: string): Promise<string> {
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

function planPaths(repoKey: string, planId: string): PlanPaths {
  const root = join(PLANS_DIR, repoKey, planId);
  return {
    root,
    prd: join(root, "prd.md"),
    tasks: join(root, "tasks.json"),
    progress: join(root, "progress.md"),
    session: join(root, "session.json"),
    lock: join(root, "synth.lock"),
    logs: join(root, "logs"),
    summary: join(root, "summary.md"),
  };
}

export async function createPlan(
  cwd: string,
  description: string,
): Promise<{ id: string; paths: PlanPaths; metadata: PlanMetadata }> {
  const repoKey = await getRepoKey(cwd);
  const id = generatePlanId();
  const paths = planPaths(repoKey, id);

  await ensureDir(paths.root);
  await ensureDir(paths.logs);

  const now = new Date().toISOString();
  const metadata: PlanMetadata = {
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

export async function getPlan(
  cwd: string,
  planId: string,
): Promise<{ paths: PlanPaths; metadata: PlanMetadata } | null> {
  const repoKey = await getRepoKey(cwd);
  const paths = planPaths(repoKey, planId);
  const metaPath = join(paths.root, "metadata.json");

  if (!(await fileExists(metaPath))) return null;

  const metadata = await readJson<PlanMetadata>(metaPath);
  return { paths, metadata };
}

export async function updatePlanMetadata(
  cwd: string,
  planId: string,
  updates: Partial<PlanMetadata>,
): Promise<PlanMetadata> {
  const plan = await getPlan(cwd, planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const updated: PlanMetadata = {
    ...plan.metadata,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await writeJson(join(plan.paths.root, "metadata.json"), updated);
  return updated;
}

export async function listPlans(cwd: string): Promise<PlanMetadata[]> {
  const repoKey = await getRepoKey(cwd);
  const repoDir = join(PLANS_DIR, repoKey);

  if (!(await dirExists(repoDir))) return [];

  const entries = await readdir(repoDir, { withFileTypes: true });
  const plans: PlanMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(repoDir, entry.name, "metadata.json");
    if (await fileExists(metaPath)) {
      plans.push(await readJson<PlanMetadata>(metaPath));
    }
  }

  // Sort by most recent first
  plans.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return plans;
}

export async function getMostRecentPlan(
  cwd: string,
): Promise<{ paths: PlanPaths; metadata: PlanMetadata } | null> {
  const plans = await listPlans(cwd);
  if (plans.length === 0) return null;
  return getPlan(cwd, plans[0].id);
}

export async function deletePlan(cwd: string, planId: string): Promise<boolean> {
  const repoKey = await getRepoKey(cwd);
  const paths = planPaths(repoKey, planId);
  if (!(await dirExists(paths.root))) return false;
  await rm(paths.root, { recursive: true, force: true });
  return true;
}

export function getPlanPaths(repoKey: string, planId: string): PlanPaths {
  return planPaths(repoKey, planId);
}
