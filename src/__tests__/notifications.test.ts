import { describe, test, expect, mock } from "bun:test";

// Mock node-notifier before importing notifications
mock.module("node-notifier", () => ({
  default: {
    notify: mock((_opts: Record<string, unknown>, _cb?: () => void) => {}),
  },
}));

import {
  formatDuration,
  sendNotification,
  sendCompletionNotification,
  sendMaxIterationsNotification,
  sendErrorNotification,
} from "../notifications.js";
import notifier from "node-notifier";

describe("formatDuration", () => {
  test("formats seconds only", () => {
    expect(formatDuration(30000)).toBe("0m 30s");
  });

  test("formats minutes and seconds", () => {
    expect(formatDuration(65000)).toBe("1m 5s");
  });

  test("formats larger durations", () => {
    expect(formatDuration(125000)).toBe("2m 5s");
  });

  test("formats zero", () => {
    expect(formatDuration(0)).toBe("0m 0s");
  });

  test("truncates sub-second precision", () => {
    expect(formatDuration(1500)).toBe("0m 1s");
  });
});

describe("sendNotification", () => {
  test("calls node-notifier with correct args", () => {
    const notifySpy = notifier.notify as ReturnType<typeof mock>;
    notifySpy.mockClear();

    sendNotification({ title: "Test", body: "Hello" });

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const call = notifySpy.mock.calls[0];
    expect(call[0]).toEqual({ title: "Test", message: "Hello", sound: false });
  });
});

describe("sendCompletionNotification", () => {
  test("sends correct title and body", () => {
    const notifySpy = notifier.notify as ReturnType<typeof mock>;
    notifySpy.mockClear();

    sendCompletionNotification({ durationMs: 65000, taskCount: 3 });

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const opts = notifySpy.mock.calls[0][0];
    expect(opts.title).toBe("Synth Complete");
    expect(opts.message).toBe("Completed 3 tasks in 1m 5s");
  });

  test("uses singular task for count of 1", () => {
    const notifySpy = notifier.notify as ReturnType<typeof mock>;
    notifySpy.mockClear();

    sendCompletionNotification({ durationMs: 30000, taskCount: 1 });

    const opts = notifySpy.mock.calls[0][0];
    expect(opts.message).toBe("Completed 1 task in 0m 30s");
  });
});

describe("sendMaxIterationsNotification", () => {
  test("sends correct title and body", () => {
    const notifySpy = notifier.notify as ReturnType<typeof mock>;
    notifySpy.mockClear();

    sendMaxIterationsNotification({
      iterationsRun: 20,
      tasksCompleted: 15,
      tasksRemaining: 5,
      durationMs: 120000,
    });

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const opts = notifySpy.mock.calls[0][0];
    expect(opts.title).toBe("Synth Max Iterations");
    expect(opts.message).toContain("20 iterations");
    expect(opts.message).toContain("Completed 15");
    expect(opts.message).toContain("5 remaining");
  });
});

describe("sendErrorNotification", () => {
  test("sends correct title and truncates long errors", () => {
    const notifySpy = notifier.notify as ReturnType<typeof mock>;
    notifySpy.mockClear();

    const longError = "A".repeat(200);
    sendErrorNotification({
      errorSummary: longError,
      tasksCompleted: 3,
      durationMs: 60000,
    });

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const opts = notifySpy.mock.calls[0][0];
    expect(opts.title).toBe("Synth Error");
    expect(opts.message).toContain("...");
    expect(opts.message.length).toBeLessThan(250);
  });

  test("does not truncate short errors", () => {
    const notifySpy = notifier.notify as ReturnType<typeof mock>;
    notifySpy.mockClear();

    sendErrorNotification({
      errorSummary: "Connection refused",
      tasksCompleted: 0,
      durationMs: 5000,
    });

    const opts = notifySpy.mock.calls[0][0];
    expect(opts.message).toContain("Connection refused");
    expect(opts.message).not.toContain("...");
  });
});
