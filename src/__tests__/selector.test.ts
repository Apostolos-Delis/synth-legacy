import { describe, test, expect } from "bun:test";
import { selectNextTask } from "../tasks/selector.js";
import type { TaskFile, Task } from "../tasks/types.js";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "US-001",
    title: "Test task",
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

describe("selectNextTask", () => {
  test("returns null for empty task list", () => {
    expect(selectNextTask(makeTaskFile([]))).toBeNull();
  });

  test("returns null when all tasks are done", () => {
    const tf = makeTaskFile([
      makeTask({ id: "US-001", status: "done" }),
      makeTask({ id: "US-002", status: "skipped" }),
    ]);
    expect(selectNextTask(tf)).toBeNull();
  });

  test("returns null when all open tasks are blocked by deps", () => {
    const tf = makeTaskFile([
      makeTask({ id: "US-001", status: "open", dependsOn: ["US-002"] }),
      makeTask({ id: "US-002", status: "open", dependsOn: ["US-001"] }),
    ]);
    expect(selectNextTask(tf)).toBeNull();
  });

  test("selects highest priority task", () => {
    const tf = makeTaskFile([
      makeTask({ id: "US-001", priority: 3 }),
      makeTask({ id: "US-002", priority: 1 }),
      makeTask({ id: "US-003", priority: 2 }),
    ]);
    expect(selectNextTask(tf)?.id).toBe("US-002");
  });

  test("respects dependency ordering", () => {
    const tf = makeTaskFile([
      makeTask({ id: "US-001", priority: 1, dependsOn: ["US-002"] }),
      makeTask({ id: "US-002", priority: 2 }),
    ]);
    expect(selectNextTask(tf)?.id).toBe("US-002");
  });

  test("selects unblocked task when dependency is done", () => {
    const tf = makeTaskFile([
      makeTask({ id: "US-001", priority: 1, dependsOn: ["US-002"] }),
      makeTask({ id: "US-002", priority: 2, status: "done" }),
    ]);
    expect(selectNextTask(tf)?.id).toBe("US-001");
  });

  test("skips in_progress and failed tasks", () => {
    const tf = makeTaskFile([
      makeTask({ id: "US-001", status: "in_progress" }),
      makeTask({ id: "US-002", status: "failed" }),
      makeTask({ id: "US-003", status: "open", priority: 5 }),
    ]);
    expect(selectNextTask(tf)?.id).toBe("US-003");
  });

  test("uses ID as tiebreaker for equal priority", () => {
    const tf = makeTaskFile([
      makeTask({ id: "US-003", priority: 2 }),
      makeTask({ id: "US-001", priority: 2 }),
      makeTask({ id: "US-002", priority: 2 }),
    ]);
    expect(selectNextTask(tf)?.id).toBe("US-001");
  });
});
