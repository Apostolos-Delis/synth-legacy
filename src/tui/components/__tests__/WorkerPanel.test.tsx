import { describe, test, expect } from "bun:test";

/**
 * Tests for WorkerPanel / WorkerRow rendering logic.
 *
 * The component is an @opentui React component that cannot be rendered in
 * unit tests, so we verify the data-driven logic it relies on: taskId
 * display, width calculation, and status icon mapping.
 *
 * Constants are inlined to avoid transitive @opentui/core import from theme.ts.
 */

// ---------------------------------------------------------------------------
// Inlined constants (mirrored from theme.ts / WorkerPanel.tsx)
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["\u280B","\u2819","\u2839","\u2838","\u283C","\u2834","\u2826","\u2827","\u2807","\u280F"];
const BRANCH_MAX_LEN = 18;

type WorkerStatus = "running" | "completed" | "failed";

interface WorkerInfo {
  id: string;
  taskId: string;
  taskTitle: string;
  iteration: number;
  maxIterations: number;
  startTime: number;
  elapsedMs: number;
  status: WorkerStatus;
  lastOutput: string;
  branchName: string;
  lastCommitSha: string;
}

// ---------------------------------------------------------------------------
// Mock data builders
// ---------------------------------------------------------------------------

function makeWorker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id: "w1",
    taskId: "FIX-001-abc",
    taskTitle: "Fix the login bug",
    iteration: 1,
    maxIterations: 3,
    startTime: Date.now() - 5000,
    elapsedMs: 5000,
    status: "running",
    lastOutput: "",
    branchName: "fix/login-bug",
    lastCommitSha: "abc1234def5678",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers: replicate WorkerRow's data-driven rendering logic
// ---------------------------------------------------------------------------

/**
 * Replicates WorkerRow's segment-building logic to produce the text segments
 * that would be rendered. Returns an array of {text, role} objects.
 */
function buildRowSegments(
  worker: WorkerInfo,
  maxIdLen: number,
  titleMaxLen: number,
  spinnerFrame: number,
): { text: string; role: string }[] {
  const segments: { text: string; role: string }[] = [];

  // Status icon
  const icon =
    worker.status === "running"
      ? SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]
      : worker.status === "completed"
        ? "\u2713"
        : "\u2717";
  segments.push({ text: icon, role: "icon" });
  segments.push({ text: " ", role: "sep" });

  // Task ID (conditional) — mirrors lines 93-98 of WorkerPanel.tsx
  if (worker.taskId) {
    segments.push({ text: worker.taskId.length > 8 ? worker.taskId.slice(0, 7) + "…" : worker.taskId, role: "taskId" });
    segments.push({ text: " ", role: "sep" });
  }

  // Worker ID
  segments.push({ text: worker.id.padEnd(maxIdLen), role: "workerId" });
  segments.push({ text: " ", role: "sep" });

  // Branch
  const branch =
    worker.branchName.length > BRANCH_MAX_LEN
      ? worker.branchName.slice(0, BRANCH_MAX_LEN - 1) + "\u2026"
      : worker.branchName;
  segments.push({ text: branch, role: "branch" });

  // Commit SHA
  const shortSha = worker.lastCommitSha
    ? worker.lastCommitSha.slice(0, 7)
    : "";
  if (shortSha) {
    segments.push({ text: " ", role: "sep" });
    segments.push({ text: shortSha, role: "sha" });
  }

  // Title
  segments.push({ text: " ", role: "sep" });
  const title =
    worker.taskTitle.length > titleMaxLen
      ? worker.taskTitle.slice(0, titleMaxLen - 3) + "..."
      : worker.taskTitle;
  segments.push({ text: title, role: "title" });

  // Iteration
  segments.push({ text: " ", role: "sep" });
  segments.push({
    text: `${worker.iteration}/${worker.maxIterations}`,
    role: "iter",
  });

  return segments;
}

/**
 * Replicates WorkerPanel's width calculation for the title column.
 * Mirrors lines 144-150 of WorkerPanel.tsx.
 */
function computeTitleMaxLen(workers: WorkerInfo[], width: number): number {
  const maxIdLen = Math.max(4, ...workers.map((w) => w.id.length));
  const maxIterStr = workers.reduce(
    (m, w) => Math.max(m, `${w.iteration}/${w.maxIterations}`.length),
    3,
  );
  const hasTaskId = workers.some((w) => w.taskId);
  const fixedCols =
    1 + 1 + (hasTaskId ? 9 : 0) + maxIdLen + 1 + BRANCH_MAX_LEN + 1 + 7 + 1 + 1 + maxIterStr + 1 + 6 + 2;
  return Math.max(10, width - fixedCols);
}

// ===========================================================================
// Tests
// ===========================================================================

describe("WorkerRow taskId rendering", () => {
  test("taskId appears in rendered segments when provided", () => {
    const worker = makeWorker({ taskId: "FIX-001-abcdef" });
    const segments = buildRowSegments(worker, 4, 30, 0);

    const taskIdSegment = segments.find((s) => s.role === "taskId");
    expect(taskIdSegment).toBeDefined();
    expect(taskIdSegment!.text).toBe("FIX-001-");
  });

  test("taskId is truncated to first 8 characters", () => {
    const worker = makeWorker({ taskId: "VERY-LONG-TASK-ID-12345" });
    const segments = buildRowSegments(worker, 4, 30, 0);

    const taskIdSegment = segments.find((s) => s.role === "taskId");
    expect(taskIdSegment).toBeDefined();
    expect(taskIdSegment!.text).toBe("VERY-LON");
    expect(taskIdSegment!.text).toHaveLength(8);
  });

  test("short taskId is not padded", () => {
    const worker = makeWorker({ taskId: "AB" });
    const segments = buildRowSegments(worker, 4, 30, 0);

    const taskIdSegment = segments.find((s) => s.role === "taskId");
    expect(taskIdSegment).toBeDefined();
    expect(taskIdSegment!.text).toBe("AB");
  });

  test("no taskId segment when taskId is empty string", () => {
    const worker = makeWorker({ taskId: "" });
    const segments = buildRowSegments(worker, 4, 30, 0);

    const taskIdSegment = segments.find((s) => s.role === "taskId");
    expect(taskIdSegment).toBeUndefined();
  });

  test("no empty gap between icon and workerId when taskId is absent", () => {
    const worker = makeWorker({ taskId: "" });
    const segments = buildRowSegments(worker, 4, 30, 0);

    // When taskId is absent, after the icon+sep the next content segment
    // should be workerId — no extra separator from taskId
    const contentSegments = segments.filter((s) => s.role !== "sep");
    const iconIdx = contentSegments.findIndex((s) => s.role === "icon");
    const workerIdIdx = contentSegments.findIndex(
      (s) => s.role === "workerId",
    );
    expect(workerIdIdx).toBe(iconIdx + 1);
  });

  test("taskId present adds exactly one extra separator vs absent", () => {
    const withId = buildRowSegments(makeWorker({ taskId: "TASK-123" }), 4, 30, 0);
    const withoutId = buildRowSegments(makeWorker({ taskId: "" }), 4, 30, 0);

    const withIdSeps = withId.filter((s) => s.role === "sep").length;
    const withoutIdSeps = withoutId.filter((s) => s.role === "sep").length;

    // taskId adds one segment + one separator
    expect(withIdSeps).toBe(withoutIdSeps + 1);
  });
});

describe("WorkerPanel width calculation with taskId", () => {
  test("width budget includes 9 extra columns when any worker has taskId", () => {
    const workers = [
      makeWorker({ id: "w1", taskId: "TASK-001" }),
      makeWorker({ id: "w2", taskId: "" }),
    ];
    const titleLen = computeTitleMaxLen(workers, 120);

    const workersNoId = [
      makeWorker({ id: "w1", taskId: "" }),
      makeWorker({ id: "w2", taskId: "" }),
    ];
    const titleLenNoId = computeTitleMaxLen(workersNoId, 120);

    // When taskId is present, 9 fewer columns available for title
    expect(titleLenNoId - titleLen).toBe(9);
  });

  test("width budget omits taskId columns when no worker has taskId", () => {
    const workers = [
      makeWorker({ id: "w1", taskId: "" }),
      makeWorker({ id: "w2", taskId: "" }),
    ];
    const titleLen = computeTitleMaxLen(workers, 120);

    // Without taskId overhead: fixedCols = 1+1+0+4+1+18+1+7+1+1+3+1+6+2 = 47
    // titleMaxLen = max(10, 120-47) = 73
    expect(titleLen).toBe(73);
  });

  test("title column never goes below 10", () => {
    const workers = [makeWorker({ taskId: "TASK-001" })];
    const titleLen = computeTitleMaxLen(workers, 30);
    expect(titleLen).toBeGreaterThanOrEqual(10);
  });
});

describe("WorkerRow status icons", () => {
  test("running worker shows spinner frame", () => {
    const worker = makeWorker({ status: "running" });
    const segments = buildRowSegments(worker, 4, 30, 2);
    const icon = segments.find((s) => s.role === "icon");
    expect(icon!.text).toBe(SPINNER_FRAMES[2]);
  });

  test("completed worker shows checkmark", () => {
    const worker = makeWorker({ status: "completed" });
    const segments = buildRowSegments(worker, 4, 30, 0);
    const icon = segments.find((s) => s.role === "icon");
    expect(icon!.text).toBe("\u2713");
  });

  test("failed worker shows cross", () => {
    const worker = makeWorker({ status: "failed" });
    const segments = buildRowSegments(worker, 4, 30, 0);
    const icon = segments.find((s) => s.role === "icon");
    expect(icon!.text).toBe("\u2717");
  });
});
