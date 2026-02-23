import { describe, test, expect } from "bun:test";
import {
  updateTaskStatus,
  allTasksDone,
  getProgress,
  resetOrphanedTasks,
} from "../tasks/store.js";
import type { Task, TaskFile } from "../tasks/types.js";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "US-001",
    title: "Test",
    description: "desc",
    acceptanceCriteria: [],
    priority: 3,
    status: "open",
    iterationCount: 0,
    ...overrides,
  };
}

function makeTaskFile(tasks: Task[]): TaskFile {
  return { project: "test", branchName: "test", description: "test", tasks };
}

describe("updateTaskStatus", () => {
  test("updates status of target task", () => {
    const tf = makeTaskFile([makeTask({ id: "US-001" })]);
    const updated = updateTaskStatus(tf, "US-001", "done");
    expect(updated.tasks[0].status).toBe("done");
  });

  test("increments iterationCount on in_progress", () => {
    const tf = makeTaskFile([makeTask({ id: "US-001", iterationCount: 2 })]);
    const updated = updateTaskStatus(tf, "US-001", "in_progress");
    expect(updated.tasks[0].iterationCount).toBe(3);
  });

  test("does not increment iterationCount for other statuses", () => {
    const tf = makeTaskFile([makeTask({ id: "US-001", iterationCount: 2 })]);
    const updated = updateTaskStatus(tf, "US-001", "done");
    expect(updated.tasks[0].iterationCount).toBe(2);
  });

  test("appends notes", () => {
    const tf = makeTaskFile([makeTask({ id: "US-001", notes: "first note" })]);
    const updated = updateTaskStatus(tf, "US-001", "open", "second note");
    expect(updated.tasks[0].notes).toBe("first note\nsecond note");
  });

  test("sets notes when none exist", () => {
    const tf = makeTaskFile([makeTask({ id: "US-001" })]);
    const updated = updateTaskStatus(tf, "US-001", "open", "new note");
    expect(updated.tasks[0].notes).toBe("new note");
  });

  test("marks all criteriaCompleted true when status becomes done", () => {
    const tf = makeTaskFile([
      makeTask({
        id: "US-001",
        acceptanceCriteria: ["crit1", "crit2", "crit3"],
      }),
    ]);
    const updated = updateTaskStatus(tf, "US-001", "done");
    expect(updated.tasks[0].criteriaCompleted).toEqual([true, true, true]);
  });

  test("does not change criteriaCompleted for non-done status", () => {
    const tf = makeTaskFile([
      makeTask({
        id: "US-001",
        acceptanceCriteria: ["crit1", "crit2"],
        criteriaCompleted: [true, false],
      }),
    ]);
    const updated = updateTaskStatus(tf, "US-001", "in_progress");
    expect(updated.tasks[0].criteriaCompleted).toEqual([true, false]);
  });

  test("handles task without criteriaCompleted (backward compat)", () => {
    const tf = makeTaskFile([
      makeTask({ id: "US-001", acceptanceCriteria: ["crit1"] }),
    ]);
    // criteriaCompleted is undefined by default
    expect(tf.tasks[0].criteriaCompleted).toBeUndefined();
    const updated = updateTaskStatus(tf, "US-001", "in_progress");
    expect(updated.tasks[0].criteriaCompleted).toBeUndefined();
  });

  test("does not modify other tasks", () => {
    const tf = makeTaskFile([
      makeTask({ id: "US-001" }),
      makeTask({ id: "US-002", status: "open" }),
    ]);
    const updated = updateTaskStatus(tf, "US-001", "done");
    expect(updated.tasks[1].status).toBe("open");
  });
});

describe("allTasksDone", () => {
  test("returns true when all done or skipped", () => {
    const tf = makeTaskFile([
      makeTask({ status: "done" }),
      makeTask({ id: "US-002", status: "skipped" }),
    ]);
    expect(allTasksDone(tf)).toBe(true);
  });

  test("returns false when any task is open", () => {
    const tf = makeTaskFile([
      makeTask({ status: "done" }),
      makeTask({ id: "US-002", status: "open" }),
    ]);
    expect(allTasksDone(tf)).toBe(false);
  });

  test("returns false when any task is in_progress", () => {
    const tf = makeTaskFile([makeTask({ status: "in_progress" })]);
    expect(allTasksDone(tf)).toBe(false);
  });

  test("returns true for empty task list", () => {
    expect(allTasksDone(makeTaskFile([]))).toBe(true);
  });
});

describe("getProgress", () => {
  test("counts task statuses correctly", () => {
    const tf = makeTaskFile([
      makeTask({ id: "US-001", status: "done" }),
      makeTask({ id: "US-002", status: "done" }),
      makeTask({ id: "US-003", status: "open" }),
      makeTask({ id: "US-004", status: "failed" }),
      makeTask({ id: "US-005", status: "in_progress" }),
    ]);
    const progress = getProgress(tf);
    expect(progress.total).toBe(5);
    expect(progress.done).toBe(2);
    expect(progress.open).toBe(1);
    expect(progress.failed).toBe(1);
    expect(progress.inProgress).toBe(1);
  });
});

describe("resetOrphanedTasks", () => {
  test("resets in_progress tasks to open", () => {
    const tf = makeTaskFile([
      makeTask({ id: "US-001", status: "in_progress" }),
      makeTask({ id: "US-002", status: "done" }),
    ]);
    const reset = resetOrphanedTasks(tf);
    expect(reset.tasks[0].status).toBe("open");
    expect(reset.tasks[0].notes).toContain("orphaned");
    expect(reset.tasks[1].status).toBe("done");
  });

  test("returns same object when no orphans", () => {
    const tf = makeTaskFile([makeTask({ status: "open" })]);
    const result = resetOrphanedTasks(tf);
    expect(result).toBe(tf);
  });
});
