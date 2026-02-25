import { memo, useState, useEffect, type ReactNode } from "react";
import { SPINNER_FRAMES, boldAttr, colors } from "../theme.js";

export type WorkerStatus = "running" | "completed" | "failed";

export interface WorkerInfo {
  id: string;
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

function formatElapsedMs(elapsedMs: number): string {
  const secs = Math.max(0, Math.floor(elapsedMs / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m${rem.toString().padStart(2, "0")}s`;
}

const BRANCH_MAX_LEN = 18;

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
  const elapsed = worker.status === "running"
    ? formatElapsed(worker.startTime, now)
    : formatElapsedMs(worker.elapsedMs);
  const iterStr = `${worker.iteration}/${worker.maxIterations}`;
  const shortSha = worker.lastCommitSha ? worker.lastCommitSha.slice(0, 7) : "";
  const branch =
    worker.branchName.length > BRANCH_MAX_LEN
      ? worker.branchName.slice(0, BRANCH_MAX_LEN - 1) + "…"
      : worker.branchName;

  const icon =
    worker.status === "running"
      ? SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]
      : STATUS_ICON[worker.status];

  return (
    <text truncate={true}>
      <span fg={STATUS_COLOR[worker.status]}>{icon}</span>
      {" "}
      <span fg={colors.fg.primary} attributes={boldAttr()}>{paddedId}</span>
      {" "}
      <span fg={colors.fg.muted}>{branch}</span>
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
  const maxIterStr = sorted.reduce((m, w) => Math.max(m, `${w.iteration}/${w.maxIterations}`.length), 3);
  // Budget: icon(1) sp(1) id(maxIdLen) sp(1) branch(BRANCH_MAX_LEN) sp(1) sha(7) sp(1) title sp(1) iter(maxIterStr) sp(1) elapsed(6)
  // Subtract 2 for box borders
  const fixedCols = 1 + 1 + maxIdLen + 1 + BRANCH_MAX_LEN + 1 + 7 + 1 + 1 + maxIterStr + 1 + 6 + 2;
  const titleMaxLen = Math.max(10, width - fixedCols);

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
      overflow="hidden"
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
