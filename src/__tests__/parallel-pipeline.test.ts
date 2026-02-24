import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "../utils/process.js";
import type { Task } from "../tasks/types.js";
import type { SessionPaths } from "../sessions/types.js";
import type { ParallelEvent } from "../parallel/events.js";
import type { WorktreeInfo } from "../parallel/worktree-manager.js";
import type { WorkerResult } from "../parallel/merge-engine.js";
import {
  ParallelCoordinator,
  type WorkerExecutor,
} from "../parallel/coordinator.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const handle = spawn({ cmd: ["git", ...args], cwd });
  const result = await handle.promise;
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "synth-parallel-test-"));
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "test@test.com");
  await git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "README.md"), "# test repo\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "initial commit");
  return dir;
}

function makeSessionPaths(repoRoot: string): SessionPaths {
  const root = join(repoRoot, ".synth-session");
  return {
    root,
    prd: join(root, "prd.md"),
    tasks: join(root, "tasks.json"),
    progress: join(root, "progress.json"),
    run: join(root, "run.json"),
    lock: join(root, "lock"),
    logs: join(root, "logs"),
    summary: join(root, "summary.md"),
    interview: join(root, "interview.json"),
    reviewRoot: join(root, "review"),
    reviewFindings: join(root, "review", "findings.json"),
    reviewTasks: join(root, "review", "tasks.json"),
    reviewProgress: join(root, "review", "progress.json"),
    reviewConversation: join(root, "review", "conversation.json"),
  };
}

function makeTasks(): Task[] {
  // 3 independent tasks at depth 0, 3 dependent tasks at depth 1
  return [
    {
      id: "task-a",
      title: "Create file A",
      description: "Creates fileA.txt",
      acceptanceCriteria: [],
      priority: 2,
      status: "open",
      affects: ["fileA.txt"],
      iterationCount: 0,
    },
    {
      id: "task-b",
      title: "Create file B",
      description: "Creates fileB.txt",
      acceptanceCriteria: [],
      priority: 2,
      status: "open",
      affects: ["fileB.txt"],
      iterationCount: 0,
    },
    {
      id: "task-c",
      title: "Create file C",
      description: "Creates fileC.txt",
      acceptanceCriteria: [],
      priority: 2,
      status: "open",
      affects: ["fileC.txt"],
      iterationCount: 0,
    },
    {
      id: "task-d",
      title: "Create file D",
      description: "Creates fileD.txt (depends on A)",
      acceptanceCriteria: [],
      priority: 2,
      status: "open",
      affects: ["fileD.txt"],
      dependsOn: ["task-a"],
      iterationCount: 0,
    },
    {
      id: "task-e",
      title: "Create file E",
      description: "Creates fileE.txt (depends on B)",
      acceptanceCriteria: [],
      priority: 2,
      status: "open",
      affects: ["fileE.txt"],
      dependsOn: ["task-b"],
      iterationCount: 0,
    },
    {
      id: "task-f",
      title: "Create file F",
      description: "Creates fileF.txt (depends on C)",
      acceptanceCriteria: [],
      priority: 2,
      status: "open",
      affects: ["fileF.txt"],
      dependsOn: ["task-c"],
      iterationCount: 0,
    },
  ];
}

/**
 * Mock executor that writes a distinct file in the worktree,
 * commits it, and returns the result.
 */
function makeExecutor(): WorkerExecutor & { callLog: string[] } {
  const callLog: string[] = [];
  return {
    callLog,
    async execute(task: Task, worktree: WorktreeInfo): Promise<WorkerResult> {
      callLog.push(task.id);

      const filename = `${task.id}.txt`;
      const filepath = join(worktree.path, filename);
      await writeFile(filepath, `content from ${task.id}\n`);

      await git(worktree.path, "add", filename);
      await git(worktree.path, "commit", "-m", `feat: ${task.title}`);

      return {
        workerId: worktree.workerId,
        taskId: task.id,
        taskTitle: task.title,
        branch: worktree.branch,
      };
    },
  };
}

describe("parallel pipeline integration", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await initRepo();
    // Create .synth dir for session state
    await mkdir(join(repoRoot, ".synth-session", ".synth"), { recursive: true });
  });

  afterEach(async () => {
    // Clean up worktree directories that might linger
    const worktreeBase = join(repoRoot, "..", ".synth-worktrees");
    await rm(worktreeBase, { recursive: true, force: true }).catch(() => {});
    await rm(repoRoot, { recursive: true, force: true });
  });

  test("full pipeline: 6 tasks with dependencies through parallel coordinator", async () => {
    const tasks = makeTasks();
    const sessionPaths = makeSessionPaths(repoRoot);
    const executor = makeExecutor();
    const events: ParallelEvent[] = [];

    const coordinator = new ParallelCoordinator({
      tasks,
      repoRoot,
      project: "test-project",
      sessionPaths,
      config: {
        maxWorkers: 3,
        aiConflictResolution: false,
        maxRequeueCount: 0,
      },
      executor,
    });

    coordinator.on((event) => events.push(event));

    const originalBranch = await git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD");
    expect(originalBranch).toBe("main");

    const result = await coordinator.run();

    // --- AC #1: 6-task plan with 3 independent + 3 dependent ---
    // The task graph should have created 2 groups: depth-0 (3 tasks) and depth-1 (3 tasks)
    expect(result.serial).toBe(false);
    expect(result.mergedTaskIds.length).toBe(6);
    expect(result.failedTaskIds.length).toBe(0);

    // --- AC #2: Mock workers create distinct files per task ---
    // All 6 tasks should have been executed
    expect(executor.callLog.length).toBe(6);
    expect(executor.callLog).toContain("task-a");
    expect(executor.callLog).toContain("task-b");
    expect(executor.callLog).toContain("task-c");
    expect(executor.callLog).toContain("task-d");
    expect(executor.callLog).toContain("task-e");
    expect(executor.callLog).toContain("task-f");

    // --- AC #3: Depth-0 tasks execute in parallel (verified via event order) ---
    // Depth-0 tasks (a,b,c) should all have worker:created events before any
    // depth-1 task (d,e,f) gets a worker:created event.
    // We verify by checking that group-started/group-completed events bracket the groups.
    const groupStartEvents = events.filter((e) => e.type === "parallel:group-started");
    const groupCompleteEvents = events.filter((e) => e.type === "parallel:group-completed");
    expect(groupStartEvents.length).toBe(2);
    expect(groupCompleteEvents.length).toBe(2);

    // Worker events for depth-0 should appear before depth-1
    const workerCreatedEvents = events.filter((e) => e.type === "worker:created");
    expect(workerCreatedEvents.length).toBe(6);

    // The first 3 worker:created should be for depth-0 tasks (a,b,c)
    const firstGroupWorkerIds = workerCreatedEvents.slice(0, 3).map(
      (e) => (e as { workerId: string }).workerId,
    );
    // Worker IDs contain the task ID
    const depth0TaskIds = ["task-a", "task-b", "task-c"];
    for (const wid of firstGroupWorkerIds) {
      expect(depth0TaskIds.some((tid) => wid.includes(tid))).toBe(true);
    }

    // The last 3 worker:created should be for depth-1 tasks (d,e,f)
    const secondGroupWorkerIds = workerCreatedEvents.slice(3, 6).map(
      (e) => (e as { workerId: string }).workerId,
    );
    const depth1TaskIds = ["task-d", "task-e", "task-f"];
    for (const wid of secondGroupWorkerIds) {
      expect(depth1TaskIds.some((tid) => wid.includes(tid))).toBe(true);
    }

    // --- AC #4: All changes present on session branch after merge ---
    // We're back on main after the coordinator finishes; verify all files exist
    const currentBranch = await git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD");
    expect(currentBranch).toBe("main");

    for (const taskId of ["task-a", "task-b", "task-c", "task-d", "task-e", "task-f"]) {
      const content = await readFile(join(repoRoot, `${taskId}.txt`), "utf-8");
      expect(content).toBe(`content from ${taskId}\n`);
    }

    // --- AC #5: Session branch merges to original branch cleanly ---
    // Verify we're on main and all commits are present
    const log = await git(repoRoot, "log", "--oneline");
    expect(log).toContain("initial commit");
    // Should have commits from each task
    for (const taskId of ["task-a", "task-b", "task-c", "task-d", "task-e", "task-f"]) {
      const task = tasks.find((t) => t.id === taskId)!;
      expect(log).toContain(task.title);
    }

    // --- AC #6: No orphaned worktrees or branches after completion ---
    const worktreeList = await git(repoRoot, "worktree", "list", "--porcelain");
    // Only the main worktree should remain
    const worktreeBlocks = worktreeList.split("\n\n").filter(Boolean);
    expect(worktreeBlocks.length).toBe(1);

    // No synth-parallel worktree branches should remain
    const branches = await git(repoRoot, "branch", "--list");
    expect(branches).not.toContain("synth-parallel/");
    // Session branch may linger (coordinator doesn't delete it after FF merge)
    // but no synth-parallel worker branches should exist
    const branchLines = branches
      .split("\n")
      .map((b) => b.trim().replace("* ", ""))
      .filter(Boolean);
    expect(branchLines.some((b) => b.startsWith("synth-parallel/"))).toBe(false);

    // Session-start tag should be cleaned up by coordinator
    const sessionStartTags = await git(repoRoot, "tag", "--list", "synth/session-start/*");
    expect(sessionStartTags).toBe("");

    // --- AC #7: Correct event sequence emitted ---
    const eventTypes = events.map((e) => e.type);

    // Must start with parallel:started
    expect(eventTypes[0]).toBe("parallel:started");

    // Must end with parallel:completed
    expect(eventTypes[eventTypes.length - 1]).toBe("parallel:completed");

    // Should have the right structure:
    // parallel:started -> group-started -> workers -> merges -> group-completed -> ... -> parallel:completed
    const expectedSequence = [
      "parallel:started",
      "parallel:group-started",
      "parallel:group-completed",
      "parallel:group-started",
      "parallel:group-completed",
      "parallel:completed",
    ];
    const sessionEvents = eventTypes.filter((t) =>
      t.startsWith("parallel:") || false,
    );
    expect(sessionEvents).toEqual(expectedSequence);

    // Each group should have worker:created/started/completed and merge events
    const workerCompleted = events.filter((e) => e.type === "worker:completed");
    expect(workerCompleted.length).toBe(6);

    const mergeCompleted = events.filter((e) => e.type === "merge:completed");
    expect(mergeCompleted.length).toBe(6);

    // Merge events should follow worker events within each group
    const mergeQueued = events.filter((e) => e.type === "merge:queued");
    expect(mergeQueued.length).toBe(6);
  }, 30_000);
});
