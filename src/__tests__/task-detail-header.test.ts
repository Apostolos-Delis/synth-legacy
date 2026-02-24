import { describe, test, expect } from "bun:test";
import { statusIndicators, STATUS_COLORS_HEX, PRIORITY_COLORS_HEX, colors } from "../tui/theme.js";
import { makeTask } from "./helpers.js";
import type { Task } from "../tasks/types.js";

/**
 * Tests for TaskDetailHeader rendering logic.
 *
 * The component is an @opentui React component that cannot be rendered in
 * unit tests, so we verify the data-driven logic it relies on: status icon
 * mapping, status colour mapping, criteria completion indicators, text
 * truncation, and backward compatibility when criteriaCompleted is absent.
 */

describe("TaskDetailHeader status mapping", () => {
  test("each task status has a status indicator icon", () => {
    const statuses: Task["status"][] = ["open", "in_progress", "done", "failed", "skipped"];
    for (const s of statuses) {
      expect(statusIndicators[s]).toBeDefined();
      expect(typeof statusIndicators[s]).toBe("string");
    }
  });

  test("each task status has a status color", () => {
    const statuses: Task["status"][] = ["open", "in_progress", "done", "failed", "skipped"];
    for (const s of statuses) {
      expect(STATUS_COLORS_HEX[s]).toBeDefined();
      expect(STATUS_COLORS_HEX[s]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  test("done status uses success color", () => {
    expect(STATUS_COLORS_HEX["done"]).toBe(colors.status.success);
  });

  test("failed status uses error color", () => {
    expect(STATUS_COLORS_HEX["failed"]).toBe(colors.status.error);
  });

  test("in_progress status uses info color", () => {
    expect(STATUS_COLORS_HEX["in_progress"]).toBe(colors.status.info);
  });

  test("done status icon is checkmark", () => {
    expect(statusIndicators["done"]).toBe("\u2713");
  });

  test("failed status icon is cross", () => {
    expect(statusIndicators["failed"]).toBe("\u2717");
  });

  test("unknown status falls back gracefully", () => {
    // The component uses ?? "?" for unknown statuses
    const icon = statusIndicators["nonexistent"] ?? "?";
    expect(icon).toBe("?");
    const color = STATUS_COLORS_HEX["nonexistent"] ?? colors.fg.muted;
    expect(color).toBe(colors.fg.muted);
  });

  test("each priority 1-5 has a defined hex color", () => {
    for (let p = 1; p <= 5; p++) {
      expect(PRIORITY_COLORS_HEX[p]).toBeDefined();
      expect(PRIORITY_COLORS_HEX[p]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  test("priority 1 (Critical) uses error color", () => {
    expect(PRIORITY_COLORS_HEX[1]).toBe(colors.status.error);
  });

  test("priority 2 (High) uses warning color", () => {
    expect(PRIORITY_COLORS_HEX[2]).toBe(colors.status.warning);
  });
});

describe("TaskDetailHeader criteria indicators", () => {
  test("completed criterion resolves to true", () => {
    const task = makeTask({
      acceptanceCriteria: ["crit1", "crit2"],
      criteriaCompleted: [true, false],
    });
    const completed = task.criteriaCompleted;
    expect(completed?.[0] ?? false).toBe(true);
    expect(completed?.[1] ?? false).toBe(false);
  });

  test("all criteria completed when task is done", () => {
    const task = makeTask({
      acceptanceCriteria: ["a", "b", "c"],
      criteriaCompleted: [true, true, true],
      status: "done",
    });
    for (let i = 0; i < task.acceptanceCriteria.length; i++) {
      expect(task.criteriaCompleted?.[i] ?? false).toBe(true);
    }
  });

  test("mixed completion states display correctly", () => {
    const task = makeTask({
      acceptanceCriteria: ["first", "second", "third"],
      criteriaCompleted: [true, false, true],
    });
    const icons = task.acceptanceCriteria.map((_, i) => {
      const done = task.criteriaCompleted?.[i] ?? false;
      return done ? "\u2713" : "\u25CB";
    });
    expect(icons).toEqual(["\u2713", "\u25CB", "\u2713"]);
  });

  test("icon colors map correctly based on completion", () => {
    const task = makeTask({
      acceptanceCriteria: ["a", "b"],
      criteriaCompleted: [true, false],
    });
    const iconColors = task.acceptanceCriteria.map((_, i) => {
      const done = task.criteriaCompleted?.[i] ?? false;
      return done ? colors.status.success : colors.fg.muted;
    });
    expect(iconColors[0]).toBe(colors.status.success);
    expect(iconColors[1]).toBe(colors.fg.muted);
  });
});

describe("TaskDetailHeader backward compatibility", () => {
  test("task with no criteriaCompleted field loads correctly", () => {
    const task = makeTask({
      acceptanceCriteria: ["crit1", "crit2"],
    });
    // criteriaCompleted defaults to undefined in makeTask
    expect(task.criteriaCompleted).toBeUndefined();
  });

  test("missing criteriaCompleted falls back to false for all criteria", () => {
    const task = makeTask({
      acceptanceCriteria: ["a", "b", "c"],
    });
    const completed = task.criteriaCompleted;
    for (let i = 0; i < task.acceptanceCriteria.length; i++) {
      expect(completed?.[i] ?? false).toBe(false);
    }
  });

  test("criteriaCompleted shorter than acceptanceCriteria falls back for missing indices", () => {
    const task = makeTask({
      acceptanceCriteria: ["a", "b", "c"],
      criteriaCompleted: [true],
    });
    expect(task.criteriaCompleted?.[0] ?? false).toBe(true);
    expect(task.criteriaCompleted?.[1] ?? false).toBe(false);
    expect(task.criteriaCompleted?.[2] ?? false).toBe(false);
  });

  test("string-only criteria (no criteriaCompleted) loads as Task", () => {
    // Simulates a TaskFile loaded from JSON with no criteriaCompleted field
    const raw = {
      id: "US-099",
      title: "Legacy task",
      description: "From old format",
      acceptanceCriteria: ["criterion A", "criterion B"],
      priority: 3,
      status: "open",
      iterationCount: 0,
    } as Task;
    expect(raw.criteriaCompleted).toBeUndefined();
    expect(raw.acceptanceCriteria).toEqual(["criterion A", "criterion B"]);
  });
});

describe("TaskDetailHeader text truncation logic", () => {
  test("short text is not truncated", () => {
    const width = 80;
    const maxLen = width - 12;
    const text = "Short criterion";
    const result = text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
    expect(result).toBe("Short criterion");
  });

  test("long criterion text is truncated with ellipsis", () => {
    const width = 40;
    const maxLen = width - 12; // 28
    const text = "This is a very long acceptance criterion that exceeds the width";
    const result = text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
    expect(result.length).toBeLessThanOrEqual(maxLen);
    expect(result).toEndWith("...");
  });

  test("description truncation respects width", () => {
    const width = 30;
    const descMaxLen = width - 6; // 24
    const desc = "A very long description that should be truncated for display";
    const result =
      desc.length > descMaxLen
        ? desc.slice(0, descMaxLen - 3) + "..."
        : desc;
    expect(result.length).toBeLessThanOrEqual(descMaxLen);
    expect(result).toEndWith("...");
  });

  test("description within width is not truncated", () => {
    const width = 100;
    const descMaxLen = width - 6;
    const desc = "Short description";
    const result =
      desc.length > descMaxLen
        ? desc.slice(0, descMaxLen - 3) + "..."
        : desc;
    expect(result).toBe("Short description");
  });
});

describe("TaskDetailHeader word-wrap line counting", () => {
  // Mirrors the word-boundary-aware wrapping used in both
  // TaskDetailHeader (render) and OutputPane (height calc).
  function wrapLineCount(text: string, width: number): number {
    if (width <= 0 || text.length === 0) return 1;
    let count = 0;
    let remaining = text;
    while (remaining.length > 0) {
      count++;
      if (remaining.length <= width) break;
      let breakAt = remaining.lastIndexOf(" ", width);
      if (breakAt <= 0) breakAt = width;
      remaining = remaining.slice(breakAt).trimStart();
    }
    return Math.max(1, count);
  }

  test("short text fits in one line", () => {
    expect(wrapLineCount("hello", 80)).toBe(1);
  });

  test("empty text returns 1 line", () => {
    expect(wrapLineCount("", 80)).toBe(1);
  });

  test("zero width returns 1 line", () => {
    expect(wrapLineCount("hello", 0)).toBe(1);
  });

  test("text exactly at width fits in one line", () => {
    expect(wrapLineCount("abcde", 5)).toBe(1);
  });

  test("word-wrap produces more lines than naive char-split", () => {
    // "aaa bbb ccc" with width=7:
    // Naive: ceil(11/7)=2 lines
    // Word-wrap: "aaa bbb" (break at space@7 → "aaa bbb"), then "ccc" → 2 lines
    // But with width=8: "aaa bbb " fits, then "ccc" → still 2
    // Use width=6 to force 3 lines:
    // "aaa bbb ccc", width=6 → lastIndexOf(" ",6)=3 → "aaa", remaining="bbb ccc"
    // "bbb ccc", width=6 → lastIndexOf(" ",6)=3 → "bbb", remaining="ccc"
    // "ccc" fits → 3 lines. Naive: ceil(11/6)=2
    const text = "aaa bbb ccc";
    const width = 6;
    const naiveCount = Math.ceil(text.length / width); // 2
    const wordWrapCount = wrapLineCount(text, width); // 3
    expect(wordWrapCount).toBeGreaterThan(naiveCount);
    expect(wordWrapCount).toBe(3);
  });

  test("long word without spaces hard-breaks at width", () => {
    expect(wrapLineCount("abcdefghij", 5)).toBe(2);
  });

  test("multi-line description wraps correctly", () => {
    // Simulate a realistic task description at innerWidth=34 (width=40, -6 for borders)
    const desc = "Implement the post-execution review cycle for tasks";
    const innerWidth = 34;
    // "Implement the post-execution review" (35 chars) > 34
    // lastIndexOf(" ", 34) = 35? Let's trace:
    // desc.lastIndexOf(" ", 34) → index of space at position ≤34
    // desc = "Implement the post-execution review cycle for tasks"
    //         0123456789...
    // Space positions: 9, 13, 29, 36, 42, 46
    // lastIndexOf(" ", 34) → 29
    // Line 1: "Implement the post-execution" (0..29)
    // remaining: "review cycle for tasks"
    // "review cycle for tasks".length = 22 <= 34 → line 2
    // Total: 2 lines
    expect(wrapLineCount(desc, innerWidth)).toBe(2);
  });
});

describe("TaskDetailHeader criteria row limit", () => {
  test("maxCriteriaRows calculation respects height", () => {
    // Component: maxCriteriaRows = Math.max(0, height - 2 - 4)
    // (2 border + 1 title + 1 desc + 1 blank + 1 section header = 6 overhead for 1-line desc with criteria)
    expect(Math.max(0, 10 - 2 - 4)).toBe(4);
    expect(Math.max(0, 6 - 2 - 4)).toBe(0);
    expect(Math.max(0, 5 - 2 - 4)).toBe(0);
    expect(Math.max(0, 4 - 2 - 4)).toBe(0);
  });

  test("visible criteria count capped by height", () => {
    const height = 9;
    const maxCriteriaRows = Math.max(0, height - 2 - 4); // 3
    const criteria = ["a", "b", "c", "d", "e"];
    const visibleCount = Math.min(criteria.length, maxCriteriaRows);
    expect(visibleCount).toBe(3);
  });

  test("overflow indicator shows remaining count", () => {
    const height = 9;
    const maxCriteriaRows = Math.max(0, height - 2 - 4); // 3
    const criteria = ["a", "b", "c", "d", "e"];
    const visibleCount = Math.min(criteria.length, maxCriteriaRows);
    const remaining = criteria.length - visibleCount;
    expect(remaining).toBe(2);
  });
});
