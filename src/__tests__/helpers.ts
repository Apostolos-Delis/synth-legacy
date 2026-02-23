import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PlanPaths } from "../plans/types.js";
import type { Task, TaskFile } from "../tasks/types.js";

export function makePlanPaths(root: string): PlanPaths {
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

export function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "US-001",
    title: "Test task",
    description: "desc",
    acceptanceCriteria: [],
    criteriaCompleted: undefined,
    priority: 3,
    status: "open",
    iterationCount: 0,
    ...overrides,
  };
}

export function makeTaskFile(tasks: Task[]): TaskFile {
  return { project: "test", branchName: "test", description: "test", tasks };
}

export async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "synth-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}
