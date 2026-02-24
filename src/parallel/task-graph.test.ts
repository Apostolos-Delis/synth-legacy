import { describe, test, expect } from "bun:test";
import { analyzeTaskGraph } from "./task-graph.js";
import type { Task } from "../tasks/types.js";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "T-001",
    title: "Test task",
    description: "desc",
    acceptanceCriteria: [],
    priority: 3,
    status: "open",
    iterationCount: 0,
    ...overrides,
  };
}

describe("analyzeTaskGraph", () => {
  test("empty task list returns empty analysis", () => {
    const result = analyzeTaskGraph([]);
    expect(result.groups).toEqual([]);
    expect(result.cyclicTaskIds).toEqual([]);
    expect(result.maxParallelism).toBe(0);
    expect(result.recommendParallel).toBe(false);
    expect(result.nodes.size).toBe(0);
  });

  test("single task gets depth 0", () => {
    const result = analyzeTaskGraph([makeTask({ id: "A" })]);
    expect(result.groups).toEqual([{ depth: 0, taskIds: ["A"] }]);
    expect(result.cyclicTaskIds).toEqual([]);
    expect(result.maxParallelism).toBe(1);
    expect(result.recommendParallel).toBe(false);
    expect(result.nodes.get("A")!.depth).toBe(0);
  });

  test("tasks with no dependsOn are all depth 0", () => {
    const result = analyzeTaskGraph([
      makeTask({ id: "A" }),
      makeTask({ id: "B" }),
      makeTask({ id: "C" }),
    ]);
    expect(result.groups).toEqual([{ depth: 0, taskIds: ["A", "B", "C"] }]);
    expect(result.maxParallelism).toBe(3);
    expect(result.recommendParallel).toBe(true);
  });

  test("task depending on depth-0 task gets depth 1", () => {
    const result = analyzeTaskGraph([
      makeTask({ id: "A" }),
      makeTask({ id: "B", dependsOn: ["A"] }),
    ]);
    expect(result.groups).toEqual([
      { depth: 0, taskIds: ["A"] },
      { depth: 1, taskIds: ["B"] },
    ]);
    expect(result.nodes.get("A")!.depth).toBe(0);
    expect(result.nodes.get("B")!.depth).toBe(1);
  });

  test("linear chain assigns increasing depths", () => {
    const result = analyzeTaskGraph([
      makeTask({ id: "A" }),
      makeTask({ id: "B", dependsOn: ["A"] }),
      makeTask({ id: "C", dependsOn: ["B"] }),
    ]);
    expect(result.groups).toEqual([
      { depth: 0, taskIds: ["A"] },
      { depth: 1, taskIds: ["B"] },
      { depth: 2, taskIds: ["C"] },
    ]);
    expect(result.maxParallelism).toBe(1);
    expect(result.recommendParallel).toBe(false);
  });

  test("diamond DAG computes correct depths", () => {
    //   A
    //  / \
    // B   C
    //  \ /
    //   D
    const result = analyzeTaskGraph([
      makeTask({ id: "A" }),
      makeTask({ id: "B", dependsOn: ["A"] }),
      makeTask({ id: "C", dependsOn: ["A"] }),
      makeTask({ id: "D", dependsOn: ["B", "C"] }),
    ]);
    expect(result.nodes.get("A")!.depth).toBe(0);
    expect(result.nodes.get("B")!.depth).toBe(1);
    expect(result.nodes.get("C")!.depth).toBe(1);
    expect(result.nodes.get("D")!.depth).toBe(2);
    expect(result.groups).toEqual([
      { depth: 0, taskIds: ["A"] },
      { depth: 1, taskIds: ["B", "C"] },
      { depth: 2, taskIds: ["D"] },
    ]);
    expect(result.maxParallelism).toBe(2);
    expect(result.recommendParallel).toBe(true);
  });

  test("2-node cycle: both IDs in cyclicTaskIds, neither in groups", () => {
    const result = analyzeTaskGraph([
      makeTask({ id: "A", dependsOn: ["B"] }),
      makeTask({ id: "B", dependsOn: ["A"] }),
    ]);
    expect(result.cyclicTaskIds.sort()).toEqual(["A", "B"]);
    expect(result.groups).toEqual([]);
    expect(result.maxParallelism).toBe(0);
    expect(result.recommendParallel).toBe(false);
  });

  test("3-node cycle detected", () => {
    const result = analyzeTaskGraph([
      makeTask({ id: "A", dependsOn: ["C"] }),
      makeTask({ id: "B", dependsOn: ["A"] }),
      makeTask({ id: "C", dependsOn: ["B"] }),
    ]);
    expect(result.cyclicTaskIds.sort()).toEqual(["A", "B", "C"]);
    expect(result.groups).toEqual([]);
  });

  test("mixed graph: cycle plus valid tasks", () => {
    // D is independent, A<->B form a cycle, C depends on D
    const result = analyzeTaskGraph([
      makeTask({ id: "A", dependsOn: ["B"] }),
      makeTask({ id: "B", dependsOn: ["A"] }),
      makeTask({ id: "C", dependsOn: ["D"] }),
      makeTask({ id: "D" }),
    ]);
    expect(result.cyclicTaskIds.sort()).toEqual(["A", "B"]);
    expect(result.groups).toEqual([
      { depth: 0, taskIds: ["D"] },
      { depth: 1, taskIds: ["C"] },
    ]);
    expect(result.nodes.get("A")!.depth).toBe(-1);
    expect(result.nodes.get("B")!.depth).toBe(-1);
  });

  test("done/failed/skipped tasks are excluded", () => {
    const result = analyzeTaskGraph([
      makeTask({ id: "A", status: "done" }),
      makeTask({ id: "B", status: "failed" }),
      makeTask({ id: "C", status: "skipped" }),
      makeTask({ id: "D", status: "open" }),
      makeTask({ id: "E", status: "in_progress" }),
    ]);
    expect(result.nodes.size).toBe(2);
    expect(result.nodes.has("D")).toBe(true);
    expect(result.nodes.has("E")).toBe(true);
    expect(result.nodes.has("A")).toBe(false);
    expect(result.groups).toEqual([{ depth: 0, taskIds: ["D", "E"] }]);
  });

  test("in_progress tasks are included", () => {
    const result = analyzeTaskGraph([
      makeTask({ id: "A", status: "in_progress" }),
      makeTask({ id: "B", status: "open", dependsOn: ["A"] }),
    ]);
    expect(result.nodes.size).toBe(2);
    expect(result.nodes.get("A")!.depth).toBe(0);
    expect(result.nodes.get("B")!.depth).toBe(1);
  });

  test("dependsOn referencing a done task is ignored (not in actionable set)", () => {
    const result = analyzeTaskGraph([
      makeTask({ id: "A", status: "done" }),
      makeTask({ id: "B", dependsOn: ["A"] }),
    ]);
    // A is excluded; B's dep on A is ignored so B gets depth 0
    expect(result.nodes.size).toBe(1);
    expect(result.nodes.get("B")!.depth).toBe(0);
    expect(result.groups).toEqual([{ depth: 0, taskIds: ["B"] }]);
  });

  test("recommendParallel false when fewer than 3 actionable tasks", () => {
    const result = analyzeTaskGraph([
      makeTask({ id: "A" }),
      makeTask({ id: "B" }),
    ]);
    expect(result.recommendParallel).toBe(false);
  });

  test("recommendParallel false when 3+ tasks but no group has 2+ tasks", () => {
    const result = analyzeTaskGraph([
      makeTask({ id: "A" }),
      makeTask({ id: "B", dependsOn: ["A"] }),
      makeTask({ id: "C", dependsOn: ["B"] }),
    ]);
    expect(result.recommendParallel).toBe(false);
  });

  test("recommendParallel true when 3+ tasks and a group has 2+ tasks", () => {
    const result = analyzeTaskGraph([
      makeTask({ id: "A" }),
      makeTask({ id: "B" }),
      makeTask({ id: "C" }),
    ]);
    expect(result.recommendParallel).toBe(true);
  });

  test("node dependedBy is populated correctly", () => {
    const result = analyzeTaskGraph([
      makeTask({ id: "A" }),
      makeTask({ id: "B", dependsOn: ["A"] }),
      makeTask({ id: "C", dependsOn: ["A"] }),
    ]);
    expect(result.nodes.get("A")!.dependedBy.sort()).toEqual(["B", "C"]);
    expect(result.nodes.get("B")!.dependsOn).toEqual(["A"]);
    expect(result.nodes.get("C")!.dependsOn).toEqual(["A"]);
  });

  test("complex multi-node cycle with tail", () => {
    // E -> A -> B -> C -> A (cycle), D depends on E
    const result = analyzeTaskGraph([
      makeTask({ id: "A", dependsOn: ["C", "E"] }),
      makeTask({ id: "B", dependsOn: ["A"] }),
      makeTask({ id: "C", dependsOn: ["B"] }),
      makeTask({ id: "D", dependsOn: ["E"] }),
      makeTask({ id: "E" }),
    ]);
    expect(result.cyclicTaskIds.sort()).toEqual(["A", "B", "C"]);
    expect(result.groups).toEqual([
      { depth: 0, taskIds: ["E"] },
      { depth: 1, taskIds: ["D"] },
    ]);
  });
});
