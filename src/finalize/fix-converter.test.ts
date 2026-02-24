import { describe, test, expect } from "bun:test";
import { fixTasksToTasks } from "./fix-converter.js";
import type { FixTask } from "./chat-types.js";

function makeFix(overrides: Partial<FixTask> = {}): FixTask {
  return {
    id: "FIX-001",
    description: "Fix the broken import",
    acceptanceCriteria: ["Import resolves correctly"],
    priority: 2,
    status: "accepted",
    sourceIssue: {
      severity: "major",
      category: "code-review",
      description: "Broken import in utils.ts",
    },
    ...overrides,
  };
}

describe("fixTasksToTasks", () => {
  test("converts empty array to empty array", () => {
    expect(fixTasksToTasks([], "/tmp")).toEqual([]);
  });

  test("converts a single fix to a task", () => {
    const fixes = [makeFix()];
    const tasks = fixTasksToTasks(fixes, "/repo");

    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("FIX-001");
    expect(tasks[0].title).toBe("Fix the broken import");
    expect(tasks[0].status).toBe("open");
    expect(tasks[0].iterationCount).toBe(0);
    expect(tasks[0].acceptanceCriteria).toEqual(["Import resolves correctly"]);
    expect(tasks[0].description).toContain("Fix the broken import");
    expect(tasks[0].description).toContain("/repo");
    expect(tasks[0].description).toContain("Import resolves correctly");
  });

  test("maps priority 1 → 1, 2 → 3, 3 → 5", () => {
    const fixes = [
      makeFix({ id: "FIX-001", priority: 1 }),
      makeFix({ id: "FIX-002", priority: 2 }),
      makeFix({ id: "FIX-003", priority: 3 }),
    ];
    const tasks = fixTasksToTasks(fixes, "/repo");

    expect(tasks[0].priority).toBe(1);
    expect(tasks[1].priority).toBe(3);
    expect(tasks[2].priority).toBe(5);
  });

  test("has no dependsOn or affects", () => {
    const tasks = fixTasksToTasks([makeFix()], "/repo");

    expect(tasks[0].dependsOn).toBeUndefined();
    expect(tasks[0].affects).toBeUndefined();
  });

  test("truncates long title to 120 chars", () => {
    const longDesc = "A".repeat(200);
    const tasks = fixTasksToTasks([makeFix({ description: longDesc })], "/repo");

    expect(tasks[0].title.length).toBe(120);
  });

  test("converts multiple fixes preserving order", () => {
    const fixes = [
      makeFix({ id: "FIX-001", description: "First" }),
      makeFix({ id: "FIX-002", description: "Second" }),
      makeFix({ id: "FIX-003", description: "Third" }),
    ];
    const tasks = fixTasksToTasks(fixes, "/repo");

    expect(tasks.map((t) => t.id)).toEqual(["FIX-001", "FIX-002", "FIX-003"]);
    expect(tasks.map((t) => t.title)).toEqual(["First", "Second", "Third"]);
  });
});
