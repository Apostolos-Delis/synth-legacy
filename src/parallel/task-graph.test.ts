import { describe, test, expect } from "bun:test";
import { analyzeTaskGraph, recommendParallelism } from "./task-graph.js";
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

describe("recommendParallelism", () => {
  test("returns recommendedWorkers, confidence, and reason", () => {
    const tasks = [makeTask({ id: "A" }), makeTask({ id: "B" })];
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 4);
    expect(result).toHaveProperty("recommendedWorkers");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("reason");
    expect(typeof result.recommendedWorkers).toBe("number");
    expect(["high", "medium", "low"]).toContain(result.confidence);
    expect(typeof result.reason).toBe("string");
  });

  test("no affects data returns defaultMax with confidence low", () => {
    const tasks = [
      makeTask({ id: "A" }),
      makeTask({ id: "B" }),
      makeTask({ id: "C" }),
    ];
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 6);
    expect(result.recommendedWorkers).toBe(6);
    expect(result.confidence).toBe("low");
  });

  test("empty affects arrays treated as no affects data", () => {
    const tasks = [
      makeTask({ id: "A", affects: [] }),
      makeTask({ id: "B", affects: [] }),
    ];
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 4);
    expect(result.confidence).toBe("low");
    expect(result.recommendedWorkers).toBe(4);
  });

  test("disjoint affects returns defaultMax with confidence high", () => {
    const tasks = [
      makeTask({ id: "A", affects: ["src/a.ts"] }),
      makeTask({ id: "B", affects: ["src/b.ts"] }),
      makeTask({ id: "C", affects: ["src/c.ts"] }),
    ];
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 8);
    expect(result.recommendedWorkers).toBe(8);
    expect(result.confidence).toBe("high");
  });

  test(">30% tasks sharing files returns workers ≤50% of defaultMax", () => {
    // 4 tasks, 3 share "shared.ts" → 75% overlap > 30%
    const tasks = [
      makeTask({ id: "A", affects: ["shared.ts", "a.ts"] }),
      makeTask({ id: "B", affects: ["shared.ts", "b.ts"] }),
      makeTask({ id: "C", affects: ["shared.ts", "c.ts"] }),
      makeTask({ id: "D", affects: ["d.ts"] }),
    ];
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 8);
    expect(result.recommendedWorkers).toBeLessThanOrEqual(4); // ≤50% of 8
    expect(result.confidence).toBe("medium");
  });

  test("exactly 30% overlap does not reduce workers", () => {
    // 10 tasks, 3 share files → exactly 30%, should NOT reduce
    const tasks: Task[] = [];
    for (let i = 0; i < 10; i++) {
      tasks.push(
        makeTask({
          id: `T-${i}`,
          affects: i < 3 ? ["shared.ts", `file${i}.ts`] : [`file${i}.ts`],
        }),
      );
    }
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 10);
    // 30% is not >30%, so workers should be defaultMax
    expect(result.recommendedWorkers).toBe(10);
    expect(result.confidence).toBe("medium");
  });

  test("31% overlap reduces workers", () => {
    // Need >30% sharing. Use ~13 tasks with 4 sharing = 30.7%
    const tasks: Task[] = [];
    for (let i = 0; i < 13; i++) {
      tasks.push(
        makeTask({
          id: `T-${i}`,
          affects: i < 4 ? ["shared.ts", `file${i}.ts`] : [`file${i}.ts`],
        }),
      );
    }
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 10);
    expect(result.recommendedWorkers).toBeLessThanOrEqual(5);
  });

  test("worker count is always ≥1", () => {
    const tasks = [
      makeTask({ id: "A", affects: ["shared.ts"] }),
      makeTask({ id: "B", affects: ["shared.ts"] }),
    ];
    const analysis = analyzeTaskGraph(tasks);
    // Even with defaultMax=1, after 50% floor, should still be ≥1
    const result = recommendParallelism(tasks, analysis, 1);
    expect(result.recommendedWorkers).toBeGreaterThanOrEqual(1);
  });

  test("worker count is always ≤defaultMax", () => {
    const tasks = [
      makeTask({ id: "A", affects: ["a.ts"] }),
      makeTask({ id: "B", affects: ["b.ts"] }),
    ];
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 3);
    expect(result.recommendedWorkers).toBeLessThanOrEqual(3);
  });

  test("100% overlap with large defaultMax", () => {
    const tasks = [
      makeTask({ id: "A", affects: ["shared.ts"] }),
      makeTask({ id: "B", affects: ["shared.ts"] }),
      makeTask({ id: "C", affects: ["shared.ts"] }),
      makeTask({ id: "D", affects: ["shared.ts"] }),
    ];
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 20);
    expect(result.recommendedWorkers).toBeLessThanOrEqual(10); // ≤50% of 20
    expect(result.recommendedWorkers).toBeGreaterThanOrEqual(1);
    expect(result.confidence).toBe("medium");
  });

  test("mixed tasks: some with affects, some without", () => {
    // Only tasks with affects are considered for overlap
    const tasks = [
      makeTask({ id: "A", affects: ["a.ts"] }),
      makeTask({ id: "B", affects: ["b.ts"] }),
      makeTask({ id: "C" }), // no affects
    ];
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 4);
    // A and B are disjoint
    expect(result.confidence).toBe("high");
    expect(result.recommendedWorkers).toBe(4);
  });

  test("tasks not in any group are excluded from analysis", () => {
    // A<->B form a cycle (excluded from groups), C and D are valid
    const tasks = [
      makeTask({ id: "A", dependsOn: ["B"], affects: ["shared.ts"] }),
      makeTask({ id: "B", dependsOn: ["A"], affects: ["shared.ts"] }),
      makeTask({ id: "C", affects: ["c.ts"] }),
      makeTask({ id: "D", affects: ["d.ts"] }),
    ];
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 4);
    // Only C and D considered (in groups), they're disjoint
    expect(result.confidence).toBe("high");
  });
});
