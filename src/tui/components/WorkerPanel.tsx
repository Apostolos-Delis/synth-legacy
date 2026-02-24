import { memo, useState, useEffect, type ReactNode } from "react";
import { SPINNER_FRAMES, boldAttr, colors } from "../theme.js";

export type WorkerStatus = "running" | "completed" | "failed";

export interface WorkerInfo {
  id: string;
  taskTitle: string;
  iteration: number;
  maxIterations: number;
  startTime: number;
  status: WorkerStatus;
  lastOutput: string;
  branchName: string;
  lastCommitSha: string;
}

interface WorkerPanelProps {
  workers: WorkerInfo[];
  width: number;
  height: number;
}

const STATUS_ICON: Record<WorkerStatus, string> = {
  running: "", // placeholder — spinner rendered inline
  completed: "\u2713", // ✓
  failed: "\u2717",    // ✗
};

const STATUS_COLOR: Record<WorkerStatus, string> = {
  running: colors.status.info,
  completed: colors.status.success,
  failed: colors.status.error,
};

function formatElapsed(startTime: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - startTime) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m${rem.toString().padStart(2, "0")}s`;
}

function WorkerRow({
  worker,
  maxIdLen,
  titleMaxLen,
  now,
  spinnerFrame,
}: {
  worker: WorkerInfo;
  maxIdLen: number;
  titleMaxLen: number;
  now: number;
  spinnerFrame: number;
}): ReactNode {
  const title =
    worker.taskTitle.length > titleMaxLen
      ? worker.taskTitle.slice(0, titleMaxLen - 3) + "..."
      : worker.taskTitle;
  const paddedId = worker.id.padEnd(maxIdLen);
  const elapsed = formatElapsed(worker.startTime, now);
  const iterStr = `${worker.iteration}/${worker.maxIterations}`;
  const shortSha = worker.lastCommitSha ? worker.lastCommitSha.slice(0, 7) : "";
  const outputMaxLen = titleMaxLen;
  const lastOut =
    worker.lastOutput.length > outputMaxLen
      ? worker.lastOutput.slice(0, outputMaxLen - 3) + "..."
      : worker.lastOutput;

  const icon =
    worker.status === "running"
      ? SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]
      : STATUS_ICON[worker.status];

  return (
    <text>
      <span fg={STATUS_COLOR[worker.status]}>{icon}</span>
      {" "}
      <span fg={colors.fg.primary} attributes={boldAttr()}>{paddedId}</span>
      {" "}
      <span fg={colors.fg.muted}>{worker.branchName}</span>
      {shortSha ? (
        <>
          {" "}
          <span fg={colors.fg.dim}>{shortSha}</span>
        </>
      ) : null}
      {" "}
      <span fg={colors.fg.secondary}>{title}</span>
      {" "}
      <span fg={colors.fg.muted}>{iterStr}</span>
      {" "}
      <span fg={colors.fg.muted}>{elapsed}</span>
      {worker.lastOutput ? (
        <>
          {" "}
          <span fg={colors.fg.dim}>{lastOut}</span>
        </>
      ) : null}
    </text>
  );
}

export const WorkerPanel = memo(function WorkerPanel({
  workers,
  width,
  height,
}: WorkerPanelProps): ReactNode {
  const [now, setNow] = useState(Date.now());
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  const hasRunning = workers.some((w) => w.status === "running");

  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(() => {
      setNow(Date.now());
      setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(interval);
  }, [hasRunning]);

  // Sort workers by ID
  const sorted = [...workers].sort((a, b) => a.id.localeCompare(b.id));

  const activeCount = sorted.filter((w) => w.status === "running").length;
  const totalCount = sorted.length;
  const headerTitle = `Workers (${activeCount}/${totalCount} active)`;

  const maxIdLen = Math.max(4, ...sorted.map((w) => w.id.length));
  // Reserve space for: icon(1) + sp(1) + id + sp(1) + title + sp(1) + iter + sp(1) + elapsed
  // Approximate title budget
  const titleMaxLen = Math.max(10, width - maxIdLen - 20);

  const innerHeight = height - 2; // borders
  const needsScroll = sorted.length > innerHeight;

  const rows = sorted.map((worker) => (
    <WorkerRow
      key={worker.id}
      worker={worker}
      maxIdLen={maxIdLen}
      titleMaxLen={titleMaxLen}
      now={now}
      spinnerFrame={spinnerFrame}
    />
  ));

  return (
    <box
      width={width}
      height={height}
      border={true}
      borderColor={hasRunning ? colors.border.active : colors.border.normal}
      title={headerTitle}
      flexDirection="column"
    >
      {needsScroll ? (
        <scrollbox
          flexGrow={1}
          stickyScroll={true}
          stickyStart="top"
          style={{ flexDirection: "column" }}
        >
          {rows}
        </scrollbox>
      ) : (
        <box flexGrow={1} style={{ flexDirection: "column" }}>
          {rows}
        </box>
      )}
    </box>
  );
}, (prev, next) => {
  if (prev.width !== next.width || prev.height !== next.height) return false;
  if (prev.workers === next.workers) return true;
  if (prev.workers.length !== next.workers.length) return false;
  return prev.workers.every((w, i) => {
    const nw = next.workers[i];
    return (
      w.id === nw.id &&
      w.status === nw.status &&
      w.iteration === nw.iteration &&
      w.lastOutput === nw.lastOutput &&
      w.branchName === nw.branchName &&
      w.lastCommitSha === nw.lastCommitSha
    );
  });
});
