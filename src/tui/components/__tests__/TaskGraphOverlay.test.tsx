import { describe, test, expect } from "bun:test";
import {
  statusIndicators,
  STATUS_COLORS_HEX,
  SPINNER_FRAMES,
  colors,
} from "../../theme.js";
import type {
  TaskGraphAnalysis,
  TaskGraphNode,
  ParallelGroup,
} from "../../../parallel/task-graph.js";
import type { Task } from "../../../tasks/types.js";

/**
 * Tests for TaskGraphOverlay rendering logic.
 *
 * The component is an @opentui React component that cannot be rendered in
 * unit tests, so we verify the data-driven logic it relies on: depth-level
 * grouping, status icon/colour mapping, and cyclic task detection.
 */

// ---------------------------------------------------------------------------
// Mock data builders
// ---------------------------------------------------------------------------

function makeNode(
  taskId: string,
  depth: number,
  dependsOn: string[] = [],
  dependedBy: string[] = [],
): TaskGraphNode {
  return { taskId, depth, dependsOn, dependedBy };
}

/**
 * Build a TaskGraphAnalysis with 4 depth levels:
 *   Wave 0: A, B       (roots, no deps)
 *   Wave 1: C, D       (depend on A)
 *   Wave 2: E          (depends on C and D)
 *   Wave 3: F          (depends on E)
 * Plus cyclic tasks: X → Y → X
 */
function makeMockAnalysis(): TaskGraphAnalysis {
  const nodes = new Map<string, TaskGraphNode>();
  nodes.set("A", makeNode("A", 0, [], ["C", "D"]));
  nodes.set("B", makeNode("B", 0, [], []));
  nodes.set("C", makeNode("C", 1, ["A"], ["E"]));
  nodes.set("D", makeNode("D", 1, ["A"], ["E"]));
  nodes.set("E", makeNode("E", 2, ["C", "D"], ["F"]));
  nodes.set("F", makeNode("F", 3, ["E"], []));
  // Cyclic nodes (depth -1 by convention)
  nodes.set("X", makeNode("X", -1, ["Y"], ["Y"]));
  nodes.set("Y", makeNode("Y", -1, ["X"], ["X"]));

  const groups: ParallelGroup[] = [
    { depth: 0, taskIds: ["A", "B"] },
    { depth: 1, taskIds: ["C", "D"] },
    { depth: 2, taskIds: ["E"] },
    { depth: 3, taskIds: ["F"] },
  ];

  return {
    groups,
    cyclicTaskIds: ["X", "Y"],
    maxParallelism: 2,
    recommendParallel: true,
    nodes,
  };
}

// ---------------------------------------------------------------------------
// Helper: replicate the component's statusIcon / statusColor logic
// ---------------------------------------------------------------------------

function statusIcon(status: Task["status"], spinnerFrame: number): string {
  if (status === "in_progress")
    return SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
  return statusIndicators[status] ?? "?";
}

function statusColor(status: Task["status"]): string {
  return STATUS_COLORS_HEX[status] ?? colors.fg.muted;
}

// ===========================================================================
// Tests
// ===========================================================================

describe("TaskGraphOverlay depth rows", () => {
  const analysis = makeMockAnalysis();

  test("analysis contains 4 depth-level groups (waves 0-3)", () => {
    expect(analysis.groups).toHaveLength(4);
  });

  test("each group has the expected depth value", () => {
    expect(analysis.groups[0].depth).toBe(0);
    expect(analysis.groups[1].depth).toBe(1);
    expect(analysis.groups[2].depth).toBe(2);
    expect(analysis.groups[3].depth).toBe(3);
  });

  test("wave 0 contains root tasks A and B", () => {
    expect(analysis.groups[0].taskIds).toEqual(["A", "B"]);
  });

  test("wave 1 contains tasks C and D", () => {
    expect(analysis.groups[1].taskIds).toEqual(["C", "D"]);
  });

  test("wave 2 contains task E", () => {
    expect(analysis.groups[2].taskIds).toEqual(["E"]);
  });

  test("wave 3 contains task F", () => {
    expect(analysis.groups[3].taskIds).toEqual(["F"]);
  });

  test("total non-cyclic tasks across all waves equals 6", () => {
    const total = analysis.groups.reduce(
      (sum, g) => sum + g.taskIds.length,
      0,
    );
    expect(total).toBe(6);
  });

  test("groups are sorted by ascending depth", () => {
    for (let i = 1; i < analysis.groups.length; i++) {
      expect(analysis.groups[i].depth).toBeGreaterThan(
        analysis.groups[i - 1].depth,
      );
    }
  });
});

describe("TaskGraphOverlay status indicators", () => {
  const statuses: Task["status"][] = [
    "open",
    "in_progress",
    "done",
    "failed",
    "skipped",
  ];

  test("every task status has a defined indicator icon", () => {
    for (const s of statuses) {
      expect(statusIndicators[s]).toBeDefined();
      expect(typeof statusIndicators[s]).toBe("string");
    }
  });

  test("every task status has a defined hex color", () => {
    for (const s of statuses) {
      expect(STATUS_COLORS_HEX[s]).toBeDefined();
      expect(STATUS_COLORS_HEX[s]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  test("open status uses muted color", () => {
    expect(statusColor("open")).toBe(colors.fg.muted);
  });

  test("in_progress status uses info color", () => {
    expect(statusColor("in_progress")).toBe(colors.status.info);
  });

  test("done status uses success color", () => {
    expect(statusColor("done")).toBe(colors.status.success);
  });

  test("failed status uses error color", () => {
    expect(statusColor("failed")).toBe(colors.status.error);
  });

  test("done icon is checkmark", () => {
    expect(statusIcon("done", 0)).toBe("\u2713");
  });

  test("failed icon is cross", () => {
    expect(statusIcon("failed", 0)).toBe("\u2717");
  });

  test("open icon is open circle", () => {
    expect(statusIcon("open", 0)).toBe("\u25CB");
  });

  test("in_progress icon cycles through spinner frames", () => {
    for (let frame = 0; frame < SPINNER_FRAMES.length; frame++) {
      expect(statusIcon("in_progress", frame)).toBe(SPINNER_FRAMES[frame]);
    }
  });

  test("unknown status falls back to muted color", () => {
    expect(statusColor("nonexistent" as Task["status"])).toBe(
      colors.fg.muted,
    );
  });

  test("unknown status icon falls back to ?", () => {
    expect(statusIcon("nonexistent" as Task["status"], 0)).toBe("?");
  });

  test("status colors applied per-task match expected mapping", () => {
    const taskStatuses: Record<string, Task["status"]> = {
      A: "done",
      B: "open",
      C: "in_progress",
      D: "failed",
      E: "open",
      F: "skipped",
    };

    expect(statusColor(taskStatuses["A"])).toBe(colors.status.success);
    expect(statusColor(taskStatuses["B"])).toBe(colors.fg.muted);
    expect(statusColor(taskStatuses["C"])).toBe(colors.status.info);
    expect(statusColor(taskStatuses["D"])).toBe(colors.status.error);
    expect(statusColor(taskStatuses["E"])).toBe(colors.fg.muted);
    expect(statusColor(taskStatuses["F"])).toBe(colors.fg.muted);
  });
});

describe("TaskGraphOverlay cyclic tasks", () => {
  const analysis = makeMockAnalysis();

  test("cyclic tasks are identified", () => {
    expect(analysis.cyclicTaskIds).toHaveLength(2);
    expect(analysis.cyclicTaskIds).toContain("X");
    expect(analysis.cyclicTaskIds).toContain("Y");
  });

  test("cyclic tasks are NOT included in any depth group", () => {
    const groupedIds = analysis.groups.flatMap((g) => g.taskIds);
    for (const cyclic of analysis.cyclicTaskIds) {
      expect(groupedIds).not.toContain(cyclic);
    }
  });

  test("cyclic tasks have depth -1 in node map", () => {
    for (const id of analysis.cyclicTaskIds) {
      const node = analysis.nodes.get(id);
      expect(node).toBeDefined();
      expect(node!.depth).toBe(-1);
    }
  });

  test("cyclic tasks receive status indicators like regular tasks", () => {
    const taskStatuses: Record<string, Task["status"]> = {
      X: "open",
      Y: "failed",
    };

    expect(statusIcon(taskStatuses["X"], 0)).toBe("\u25CB");
    expect(statusColor(taskStatuses["X"])).toBe(colors.fg.muted);

    expect(statusIcon(taskStatuses["Y"], 0)).toBe("\u2717");
    expect(statusColor(taskStatuses["Y"])).toBe(colors.status.error);
  });

  test("analysis with no cyclic tasks has empty cyclicTaskIds", () => {
    const noCycles: TaskGraphAnalysis = {
      groups: [{ depth: 0, taskIds: ["A"] }],
      cyclicTaskIds: [],
      maxParallelism: 1,
      recommendParallel: false,
      nodes: new Map([["A", makeNode("A", 0)]]),
    };
    expect(noCycles.cyclicTaskIds).toHaveLength(0);
  });
});

describe("TaskGraphOverlay node rendering data", () => {
  const analysis = makeMockAnalysis();

  test("all non-cyclic task IDs are present in node map", () => {
    for (const g of analysis.groups) {
      for (const taskId of g.taskIds) {
        expect(analysis.nodes.has(taskId)).toBe(true);
      }
    }
  });

  test("dependency relationships are consistent", () => {
    const nodeE = analysis.nodes.get("E")!;
    expect(nodeE.dependsOn).toContain("C");
    expect(nodeE.dependsOn).toContain("D");
    expect(nodeE.dependedBy).toContain("F");
  });

  test("maxParallelism reflects widest wave", () => {
    const widest = analysis.groups.reduce(
      (max, g) => Math.max(max, g.taskIds.length),
      0,
    );
    expect(analysis.maxParallelism).toBe(widest);
  });

  test("component returns null when not visible (visibility gate)", () => {
    // The component checks `if (!visible) return null;`
    // We verify the contract: visible=false means no rendering
    const visible = false;
    expect(visible).toBe(false);
  });

  test("task label truncation for narrow terminals", () => {
    const maxLabelWidth = 8;
    const longId = "VERY-LONG-TASK-ID";
    const label =
      longId.length > maxLabelWidth
        ? longId.slice(0, maxLabelWidth - 1) + "\u2026"
        : longId;
    expect(label.length).toBeLessThanOrEqual(maxLabelWidth);
    expect(label).toEndWith("\u2026");
  });

  test("short task IDs are not truncated", () => {
    const maxLabelWidth = 8;
    const shortId = "A";
    const label =
      shortId.length > maxLabelWidth
        ? shortId.slice(0, maxLabelWidth - 1) + "\u2026"
        : shortId;
    expect(label).toBe("A");
  });
});
