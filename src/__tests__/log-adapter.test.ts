import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { PipelineEvent, PipelineEmitter, PipelineState, UserAction } from "../pipeline/types.js";
import type { CompletionSummary } from "../tui/types.js";

// ---------------------------------------------------------------------------
// Capture mocks for helpers, theme, and tool-format
// ---------------------------------------------------------------------------

let mockLog: ReturnType<typeof mock>;
let mockLogError: ReturnType<typeof mock>;
let mockLogSuccess: ReturnType<typeof mock>;
let mockPrintCompletionSummary: ReturnType<typeof mock>;
let mockFmtBold: ReturnType<typeof mock>;
let mockFmtInfo: ReturnType<typeof mock>;
let mockFmtWarn: ReturnType<typeof mock>;
let mockFmtDim: ReturnType<typeof mock>;
let mockFmtLabel: ReturnType<typeof mock>;
let mockFmtSuccess: ReturnType<typeof mock>;
let mockFmtError: ReturnType<typeof mock>;
let mockFormatToolEvent: ReturnType<typeof mock>;

function resetMocks() {
  mockLog = mock((_msg: string) => {});
  mockLogError = mock((_msg: string) => {});
  mockLogSuccess = mock((_msg: string) => {});
  mockPrintCompletionSummary = mock((_data: CompletionSummary) => {});

  // fmt functions just return the input for easier assertion
  mockFmtBold = mock((msg: string) => `[bold]${msg}`);
  mockFmtInfo = mock((msg: string) => `[info]${msg}`);
  mockFmtWarn = mock((msg: string) => `[warn]${msg}`);
  mockFmtDim = mock((msg: string) => `[dim]${msg}`);
  mockFmtLabel = mock((k: string, v: string) => `${k} ${v}`);
  mockFmtSuccess = mock((msg: string) => `[success]${msg}`);
  mockFmtError = mock((msg: string) => `[error]${msg}`);
  mockFormatToolEvent = mock(() => "[tool-formatted]");
}

// ---------------------------------------------------------------------------
// Module mocks — closure delegation so resetMocks() swaps implementations
// ---------------------------------------------------------------------------

mock.module("../commands/helpers.js", () => ({
  log: (...args: unknown[]) => mockLog(...args),
  logError: (...args: unknown[]) => mockLogError(...args),
  logSuccess: (...args: unknown[]) => mockLogSuccess(...args),
  printCompletionSummary: (...args: unknown[]) => mockPrintCompletionSummary(...args),
}));

mock.module("../tui/theme.js", () => ({
  fmt: {
    bold: (...args: unknown[]) => mockFmtBold(...args),
    info: (...args: unknown[]) => mockFmtInfo(...args),
    warn: (...args: unknown[]) => mockFmtWarn(...args),
    dim: (...args: unknown[]) => mockFmtDim(...args),
    label: (...args: unknown[]) => mockFmtLabel(...args),
    success: (...args: unknown[]) => mockFmtSuccess(...args),
    error: (...args: unknown[]) => mockFmtError(...args),
  },
}));

mock.module("../utils/tool-format.js", () => ({
  formatToolEvent: (...args: unknown[]) => mockFormatToolEvent(...args),
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

const { LogAdapter } = await import("../pipeline/log-adapter.js");

// ---------------------------------------------------------------------------
// Fake PipelineEmitter
// ---------------------------------------------------------------------------

type Listener = (event: PipelineEvent) => void;

function createFakeEmitter(): PipelineEmitter & { emit: (event: PipelineEvent) => void } {
  let listener: Listener | null = null;
  return {
    on(fn: Listener) {
      listener = fn;
      return () => { listener = null; };
    },
    emit(event: PipelineEvent) {
      listener?.(event);
    },
    run: async () => {},
    stop: () => {},
    getState: () => ({} as PipelineState),
    submitAction: (_action: UserAction) => {},
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides?: Partial<CompletionSummary>): CompletionSummary {
  return {
    projectName: "test-project",
    sessionId: "sess-001",
    agentName: "claude",
    totalDurationMs: 12345,
    totalIterations: 3,
    tasks: [],
    progress: { total: 2, done: 2, failed: 0, open: 0, inProgress: 0 },
    commits: [],
    summaryFilePath: "/tmp/summary.md",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LogAdapter", () => {
  let emitter: ReturnType<typeof createFakeEmitter>;
  let adapter: InstanceType<typeof LogAdapter>;
  let stdoutWriteSpy: ReturnType<typeof mock>;
  const originalStdoutWrite = process.stdout.write;

  beforeEach(() => {
    resetMocks();
    emitter = createFakeEmitter();
    adapter = new LogAdapter(emitter);
    stdoutWriteSpy = mock((..._args: unknown[]) => true);
    process.stdout.write = stdoutWriteSpy as typeof process.stdout.write;
  });

  afterEach(() => {
    adapter.dispose();
    process.stdout.write = originalStdoutWrite;
  });

  // -------------------------------------------------------------------------
  // Serial engine events
  // -------------------------------------------------------------------------

  describe("serial engine events", () => {
    test("iteration:start logs bold header with task label", () => {
      emitter.emit({
        type: "engine:event",
        event: { type: "iteration:start", iteration: 1, taskId: "T-001" },
      });

      expect(mockLog).toHaveBeenCalledTimes(1);
      expect(mockFmtBold).toHaveBeenCalled();
      expect(mockFmtLabel).toHaveBeenCalled();
      // Verify taskId is passed to label
      const labelArgs = mockFmtLabel.mock.calls[0];
      expect(labelArgs[0]).toBe("task:");
      expect(labelArgs[1]).toBe("T-001");
    });

    test("task:complete logs success with taskId and message", () => {
      emitter.emit({
        type: "engine:event",
        event: { type: "task:complete", taskId: "T-001", message: "All good" },
      });

      expect(mockLogSuccess).toHaveBeenCalledTimes(1);
      const msg = mockLogSuccess.mock.calls[0][0];
      expect(msg).toContain("T-001");
      expect(msg).toContain("All good");
    });

    test("task:failed logs error with taskId and message", () => {
      emitter.emit({
        type: "engine:event",
        event: { type: "task:failed", taskId: "T-002", message: "Crashed" },
      });

      expect(mockLogError).toHaveBeenCalledTimes(1);
      const msg = mockLogError.mock.calls[0][0];
      expect(msg).toContain("T-002");
      expect(msg).toContain("Crashed");
    });

    test("backpressure:pass logs success", () => {
      emitter.emit({
        type: "engine:event",
        event: { type: "backpressure:pass" },
      });

      expect(mockLogSuccess).toHaveBeenCalledTimes(1);
      expect(mockLogSuccess.mock.calls[0][0]).toContain("backpressure passed");
    });

    test("backpressure:fail logs error with message", () => {
      emitter.emit({
        type: "engine:event",
        event: { type: "backpressure:fail", message: "Too many tokens" },
      });

      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError.mock.calls[0][0]).toContain("Too many tokens");
    });

    test("circuit:trip logs error with message", () => {
      emitter.emit({
        type: "engine:event",
        event: { type: "circuit:trip", message: "Tripped after 3 failures" },
      });

      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError.mock.calls[0][0]).toContain("Tripped after 3 failures");
    });

    test("rate-limit:detected logs warning", () => {
      emitter.emit({
        type: "engine:event",
        event: { type: "rate-limit:detected", message: "Rate limited by API" },
      });

      expect(mockLog).toHaveBeenCalledTimes(1);
      expect(mockFmtWarn).toHaveBeenCalledWith("Rate limited by API");
    });

    test("rate-limit:detected uses default message when none provided", () => {
      emitter.emit({
        type: "engine:event",
        event: { type: "rate-limit:detected" },
      });

      expect(mockFmtWarn).toHaveBeenCalledWith("Rate limited");
    });

    test("agent:stdout writes to process.stdout", () => {
      emitter.emit({
        type: "engine:event",
        event: { type: "agent:stdout", message: "hello from agent" },
      });

      expect(stdoutWriteSpy).toHaveBeenCalledWith("hello from agent");
    });

    test("agent:stdout does nothing when message is empty", () => {
      emitter.emit({
        type: "engine:event",
        event: { type: "agent:stdout", message: "" },
      });

      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });

    test("agent:tool logs formatted tool event when showToolLogs is true", () => {
      const toolEvent = { kind: "use" as const, name: "Read", id: "t-1", input: "{}", output: "", timestamp: 0 };
      emitter.emit({
        type: "engine:event",
        event: { type: "agent:tool", tool: toolEvent },
      });

      expect(mockFormatToolEvent).toHaveBeenCalledWith(toolEvent);
      expect(mockLog).toHaveBeenCalledWith("[tool-formatted]");
    });

    test("agent:tool skips logging when showToolLogs is false", () => {
      adapter.dispose();
      adapter = new LogAdapter(emitter, { showToolLogs: false });

      const toolEvent = { kind: "use" as const, name: "Read", id: "t-1", input: "{}", output: "", timestamp: 0 };
      emitter.emit({
        type: "engine:event",
        event: { type: "agent:tool", tool: toolEvent },
      });

      expect(mockFormatToolEvent).not.toHaveBeenCalled();
      expect(mockLog).not.toHaveBeenCalled();
    });

    test("agent:tool skips when no tool data", () => {
      emitter.emit({
        type: "engine:event",
        event: { type: "agent:tool" },
      });

      expect(mockFormatToolEvent).not.toHaveBeenCalled();
    });

    test("multiple serial events in sequence", () => {
      emitter.emit({
        type: "engine:event",
        event: { type: "iteration:start", iteration: 1, taskId: "T-001" },
      });
      emitter.emit({
        type: "engine:event",
        event: { type: "task:complete", taskId: "T-001", message: "Done" },
      });
      emitter.emit({
        type: "engine:event",
        event: { type: "iteration:start", iteration: 2, taskId: "T-002" },
      });
      emitter.emit({
        type: "engine:event",
        event: { type: "task:failed", taskId: "T-002", message: "Oops" },
      });

      expect(mockLog).toHaveBeenCalledTimes(2); // two iteration:start
      expect(mockLogSuccess).toHaveBeenCalledTimes(1); // one task:complete
      expect(mockLogError).toHaveBeenCalledTimes(1); // one task:failed
    });
  });

  // -------------------------------------------------------------------------
  // Parallel events
  // -------------------------------------------------------------------------

  describe("parallel events", () => {
    test("parallel:started logs info", () => {
      emitter.emit({
        type: "parallel:event",
        event: { type: "parallel:started", timestamp: "" },
      });

      expect(mockLog).toHaveBeenCalledTimes(1);
      expect(mockFmtInfo).toHaveBeenCalledWith("Parallel execution started");
    });

    test("parallel:group-started logs info", () => {
      emitter.emit({
        type: "parallel:event",
        event: { type: "parallel:group-started", timestamp: "" },
      });

      expect(mockFmtInfo).toHaveBeenCalledWith("Starting wave");
    });

    test("worker:started logs info with workerId", () => {
      emitter.emit({
        type: "parallel:event",
        event: { type: "worker:started", timestamp: "", workerId: "w-1" },
      });

      expect(mockFmtInfo).toHaveBeenCalledWith("Worker w-1 started");
    });

    test("worker:completed logs success", () => {
      emitter.emit({
        type: "parallel:event",
        event: { type: "worker:completed", timestamp: "", workerId: "w-1" },
      });

      expect(mockLogSuccess).toHaveBeenCalledWith("Worker w-1 completed");
    });

    test("worker:failed logs error", () => {
      emitter.emit({
        type: "parallel:event",
        event: { type: "worker:failed", timestamp: "", workerId: "w-2" },
      });

      expect(mockLogError).toHaveBeenCalledWith("Worker w-2 failed");
    });

    test("merge:completed logs success with taskId", () => {
      emitter.emit({
        type: "parallel:event",
        event: { type: "merge:completed", timestamp: "", operationId: "op-1", taskId: "T-001" },
      });

      expect(mockLogSuccess).toHaveBeenCalledWith("Merged task T-001");
    });

    test("merge:failed logs error with reason", () => {
      emitter.emit({
        type: "parallel:event",
        event: { type: "merge:failed", timestamp: "", operationId: "op-1", taskId: "T-001", reason: "conflict" },
      });

      expect(mockLogError).toHaveBeenCalledWith("Merge failed for task T-001: conflict");
    });

    test("merge:failed logs error without reason", () => {
      emitter.emit({
        type: "parallel:event",
        event: { type: "merge:failed", timestamp: "", operationId: "op-1", taskId: "T-001" },
      });

      expect(mockLogError).toHaveBeenCalledWith("Merge failed for task T-001");
    });

    test("merge:skipped logs warning with reason", () => {
      emitter.emit({
        type: "parallel:event",
        event: { type: "merge:skipped", timestamp: "", taskId: "T-003", reason: "no changes" },
      });

      expect(mockFmtWarn).toHaveBeenCalledWith("Merge skipped for task T-003: no changes");
    });

    test("conflict:detected logs warning", () => {
      emitter.emit({
        type: "parallel:event",
        event: { type: "conflict:detected", timestamp: "", taskId: "T-001", taskTitle: "Task 1", files: ["a.ts"] },
      });

      expect(mockFmtWarn).toHaveBeenCalledWith("Merge conflict detected");
    });

    test("parallel:completed logs success", () => {
      emitter.emit({
        type: "parallel:event",
        event: { type: "parallel:completed", timestamp: "" },
      });

      expect(mockLogSuccess).toHaveBeenCalledWith("Parallel execution completed");
    });

    test("parallel:warning logs warning message", () => {
      emitter.emit({
        type: "parallel:event",
        event: { type: "parallel:warning", timestamp: "", message: "Watch out" },
      });

      expect(mockFmtWarn).toHaveBeenCalledWith("Watch out");
    });

    test("parallel:failed logs error", () => {
      emitter.emit({
        type: "parallel:event",
        event: { type: "parallel:failed", timestamp: "" },
      });

      expect(mockLogError).toHaveBeenCalledWith("Parallel execution failed");
    });
  });

  // -------------------------------------------------------------------------
  // Completion summary
  // -------------------------------------------------------------------------

  describe("completion summary", () => {
    test("summary:ready calls printCompletionSummary", () => {
      const summary = makeSummary();
      emitter.emit({ type: "summary:ready", summary });

      expect(mockPrintCompletionSummary).toHaveBeenCalledTimes(1);
      expect(mockPrintCompletionSummary).toHaveBeenCalledWith(summary);
    });

    test("summary:ready passes full summary data through", () => {
      const summary = makeSummary({
        totalIterations: 5,
        progress: { total: 3, done: 2, failed: 1, open: 0, inProgress: 0 },
      });
      emitter.emit({ type: "summary:ready", summary });

      const passedSummary = mockPrintCompletionSummary.mock.calls[0][0];
      expect(passedSummary.totalIterations).toBe(5);
      expect(passedSummary.progress.failed).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Review status events
  // -------------------------------------------------------------------------

  describe("review status events", () => {
    test("review running logs header and info", () => {
      emitter.emit({ type: "review:status-changed", status: "running" });

      expect(mockLog).toHaveBeenCalledTimes(2);
      expect(mockFmtBold).toHaveBeenCalled();
      expect(mockFmtInfo).toHaveBeenCalledWith("Analyzing execution output for issues...");
    });

    test("review complete logs info", () => {
      emitter.emit({ type: "review:status-changed", status: "complete" });

      expect(mockFmtInfo).toHaveBeenCalledWith("Review completed");
    });

    test("review error logs error with message", () => {
      emitter.emit({ type: "review:status-changed", status: "error", error: "timeout" });

      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError.mock.calls[0][0]).toContain("timeout");
    });

    test("review error logs without error detail", () => {
      emitter.emit({ type: "review:status-changed", status: "error" });

      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError.mock.calls[0][0]).toContain("Review failed");
    });
  });

  // -------------------------------------------------------------------------
  // Pipeline error events
  // -------------------------------------------------------------------------

  describe("pipeline error events", () => {
    test("error event logs phase and message", () => {
      emitter.emit({
        type: "error",
        error: new Error("something broke"),
        phase: "executing",
      });

      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError.mock.calls[0][0]).toContain("executing");
      expect(mockLogError.mock.calls[0][0]).toContain("something broke");
    });
  });

  // -------------------------------------------------------------------------
  // Log events
  // -------------------------------------------------------------------------

  describe("log events", () => {
    test("log level=error calls logError", () => {
      emitter.emit({ type: "log", level: "error", message: "bad stuff" });

      expect(mockLogError).toHaveBeenCalledWith("bad stuff");
    });

    test("log level=warn calls fmt.warn", () => {
      emitter.emit({ type: "log", level: "warn", message: "heads up" });

      expect(mockFmtWarn).toHaveBeenCalledWith("heads up");
    });

    test("log level=info calls fmt.info", () => {
      emitter.emit({ type: "log", level: "info", message: "fyi" });

      expect(mockFmtInfo).toHaveBeenCalledWith("fyi");
    });

    test("log level=debug calls fmt.dim", () => {
      emitter.emit({ type: "log", level: "debug", message: "trace data" });

      expect(mockFmtDim).toHaveBeenCalledWith("trace data");
    });
  });

  // -------------------------------------------------------------------------
  // Dispose / cleanup
  // -------------------------------------------------------------------------

  describe("dispose", () => {
    test("dispose prevents further event handling", () => {
      adapter.dispose();

      emitter.emit({
        type: "engine:event",
        event: { type: "iteration:start", iteration: 1, taskId: "T-001" },
      });

      expect(mockLog).not.toHaveBeenCalled();
    });

    test("double dispose does not throw", () => {
      adapter.dispose();
      expect(() => adapter.dispose()).not.toThrow();
    });
  });
});
