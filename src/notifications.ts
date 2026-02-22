import notifier from "node-notifier";

export interface NotificationOptions {
  title: string;
  body: string;
}

export function sendNotification({ title, body }: NotificationOptions): void {
  try {
    notifier.notify(
      { title, message: body, sound: false },
      (err: Error | null) => {
        if (err) {
          console.warn(`[notifications] Failed to send notification: ${err.message}`);
        }
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[notifications] Failed to send notification: ${message}`);
  }
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function sendCompletionNotification({ durationMs, taskCount }: { durationMs: number; taskCount: number }): void {
  sendNotification({
    title: "Synth Complete",
    body: `Completed ${taskCount} task${taskCount !== 1 ? "s" : ""} in ${formatDuration(durationMs)}`,
  });
}

export function sendMaxIterationsNotification({
  iterationsRun,
  tasksCompleted,
  tasksRemaining,
  durationMs,
}: {
  iterationsRun: number;
  tasksCompleted: number;
  tasksRemaining: number;
  durationMs: number;
}): void {
  sendNotification({
    title: "Synth Max Iterations",
    body: `Iteration limit reached after ${iterationsRun} iteration${iterationsRun !== 1 ? "s" : ""}. ` +
      `Completed ${tasksCompleted}, ${tasksRemaining} remaining. Duration: ${formatDuration(durationMs)}`,
  });
}

export function sendErrorNotification({
  errorSummary,
  tasksCompleted,
  durationMs,
}: {
  errorSummary: string;
  tasksCompleted: number;
  durationMs: number;
}): void {
  const maxErrorLength = 100;
  const truncatedError = errorSummary.length > maxErrorLength
    ? errorSummary.substring(0, maxErrorLength) + "..."
    : errorSummary;

  sendNotification({
    title: "Synth Error",
    body: `Error: ${truncatedError}\n` +
      `Completed ${tasksCompleted} task${tasksCompleted !== 1 ? "s" : ""} before failure. Duration: ${formatDuration(durationMs)}`,
  });
}
