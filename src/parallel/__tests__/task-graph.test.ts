import { describe, test, expect } from "bun:test";
import {
  analyzeTaskGraph,
  recommendParallelism,
} from "../task-graph.js";
import type { Task } from "../../tasks/types.js";

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

describe("recommendParallelism", () => {
  test("tasks with no affects data default to conservative parallelism", () => {
    const tasks = [
      makeTask({ id: "A" }),
      makeTask({ id: "B" }),
      makeTask({ id: "C" }),
    ];
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 6);

    expect(result.recommendedWorkers).toBe(6);
    expect(result.confidence).toBe("low");
    expect(result.reason).toContain("No affects data");
  });

  test("fully disjoint file sets allow max parallelism", () => {
    const tasks = [
      makeTask({ id: "A", affects: ["src/a.ts"] }),
      makeTask({ id: "B", affects: ["src/b.ts"] }),
      makeTask({ id: "C", affects: ["src/c.ts"] }),
      makeTask({ id: "D", affects: ["src/d.ts"] }),
    ];
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 8);

    expect(result.recommendedWorkers).toBe(8);
    expect(result.confidence).toBe("high");
    expect(result.reason).toContain("disjoint");
  });

  test(">30% file overlap reduces worker count", () => {
    // 4 tasks, 3 share "shared.ts" → 75% overlap ratio (well above 30%)
    const tasks = [
      makeTask({ id: "A", affects: ["shared.ts", "a.ts"] }),
      makeTask({ id: "B", affects: ["shared.ts", "b.ts"] }),
      makeTask({ id: "C", affects: ["shared.ts", "c.ts"] }),
      makeTask({ id: "D", affects: ["d.ts"] }),
    ];
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 8);

    // floor(8 * 0.5) = 4
    expect(result.recommendedWorkers).toBe(4);
    expect(result.confidence).toBe("medium");
    expect(result.reason).toContain("reducing parallelism");
  });

  test("single task returns 1", () => {
    const tasks = [makeTask({ id: "A", affects: ["a.ts"] })];
    const analysis = analyzeTaskGraph(tasks);
    const result = recommendParallelism(tasks, analysis, 1);

    expect(result.recommendedWorkers).toBe(1);
  });

  test("exactly 30% overlap does not reduce workers", () => {
    // 10 tasks, 3 share a file with each other → 3/10 = exactly 30%
    // 30% is NOT >30%, so workers should stay at defaultMax
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

    expect(result.recommendedWorkers).toBe(10);
    expect(result.confidence).toBe("medium");
    expect(result.reason).toContain("within safe threshold");
  });
});
