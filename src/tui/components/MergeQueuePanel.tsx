import { memo, useState, useEffect, useMemo, type ReactNode } from "react";
import { SPINNER_FRAMES, boldAttr, colors } from "../theme.js";
import { startSpan, endSpan } from "../profiler.js";

export type MergeStatus =
  | "queued"
  | "in-progress"
  | "completed"
  | "failed"
  | "conflicted"
  | "rolled-back"
  | "skipped";

export type MergeStrategy = "ff" | "merge-commit" | "squash";

export interface MergeQueueItem {
  id: string;
  taskId: string;
  status: MergeStatus;
  strategy: MergeStrategy;
  filesChanged: number;
  startTime?: number;
  endTime?: number;
  queuePosition: number;
  error?: string;
}

interface MergeQueuePanelProps {
  items: MergeQueueItem[];
  width: number;
  height: number;
}

const STATUS_LABEL: Record<MergeStatus, string> = {
  "queued": "queued",
  "in-progress": "merging",
  "completed": "merged",
  "failed": "failed",
  "conflicted": "conflict",
  "rolled-back": "rollback",
  "skipped": "skipped",
};

const STATUS_COLOR: Record<MergeStatus, string> = {
  "queued": colors.fg.muted,
  "in-progress": colors.status.warning,
  "completed": colors.status.success,
  "failed": colors.status.error,
  "conflicted": colors.status.error,
  "rolled-back": colors.status.error,
  "skipped": colors.fg.muted,
};

const STATUS_ICON: Record<MergeStatus, string> = {
  "queued": "\u25CB",     // ○
  "in-progress": "",      // placeholder — spinner rendered inline
  "completed": "\u2713",  // ✓
  "failed": "\u2717",     // ✗
  "conflicted": "\u26A0", // ⚠
  "rolled-back": "\u21B6", // ↶
  "skipped": "\u25CB",    // ○
};

function formatDuration(startTime?: number, endTime?: number, now?: number): string {
  if (!startTime) return "--";
  const end = endTime ?? now ?? Date.now();
  const secs = Math.max(0, Math.floor((end - startTime) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m${rem.toString().padStart(2, "0")}s`;
}

function MergeRow({
  item,
  maxTaskIdLen,
  now,
  spinnerFrame,
}: {
  item: MergeQueueItem;
  maxTaskIdLen: number;
  now: number;
  spinnerFrame: number;
}): ReactNode {
  const paddedTaskId = item.taskId.padEnd(maxTaskIdLen);
  const label = STATUS_LABEL[item.status].padEnd(8);
  const strategy = item.strategy === "ff" ? "ff    " : item.strategy === "squash" ? "squash" : "merge ";
  const files = `${item.filesChanged}f`.padStart(4);
  const duration = formatDuration(item.startTime, item.endTime, now).padStart(6);

  const icon =
    item.status === "in-progress"
      ? SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]
      : STATUS_ICON[item.status];

  const errorSuffix = item.status === "failed" && item.error
    ? ` ${item.error.length > 40 ? item.error.slice(0, 40) + "…" : item.error}`
    : "";

  return (
    <text>
      <span fg={STATUS_COLOR[item.status]}>{icon}</span>
      {" "}
      <span fg={colors.fg.primary} attributes={boldAttr()}>{paddedTaskId}</span>
      {" "}
      <span fg={STATUS_COLOR[item.status]}>{label}</span>
      {" "}
      <span fg={colors.fg.muted}>{strategy}</span>
      {" "}
      <span fg={colors.fg.muted}>{files}</span>
      {" "}
      <span fg={colors.fg.muted}>{duration}</span>
      {errorSuffix ? <span fg={colors.status.error}>{errorSuffix}</span> : null}
    </text>
  );
}

export const MergeQueuePanel = memo(function MergeQueuePanel({
  items,
  width,
  height,
}: MergeQueuePanelProps): ReactNode {
  const renderSpan = startSpan("MergeQueuePanel");
  const [tick, setTick] = useState(0);

  const hasInProgress = items.some((i) => i.status === "in-progress");

  useEffect(() => {
    if (!hasInProgress) return;
    const interval = setInterval(() => {
      setTick((n) => n + 1);
    }, 80);
    return () => clearInterval(interval);
  }, [hasInProgress]);

  const now = Date.now();
  const spinnerFrame = tick % SPINNER_FRAMES.length;

  // Sort by queue position
  const sorted = useMemo(
    () => [...items].sort((a, b) => a.queuePosition - b.queuePosition),
    [items],
  );

  const pendingCount = sorted.filter(
    (i) => i.status === "queued" || i.status === "in-progress",
  ).length;
  const completedCount = sorted.filter((i) => i.status === "completed").length;
  const headerTitle = `Merge Queue (${pendingCount} pending, ${completedCount} completed)`;

  const maxTaskIdLen = Math.max(4, ...sorted.map((i) => i.taskId.length));

  const innerHeight = height - 2; // borders
  const contentHeight = Math.max(1, innerHeight);
  const needsScroll = sorted.length > innerHeight;

  const rows = sorted.map((item) => (
    <MergeRow
      key={item.id}
      item={item}
      maxTaskIdLen={maxTaskIdLen}
      now={now}
      spinnerFrame={spinnerFrame}
    />
  ));

  endSpan("MergeQueuePanel", renderSpan);
  return (
    <box
      width={width}
      height={height}
      border={true}
      borderColor={hasInProgress ? colors.border.active : colors.border.normal}
      title={headerTitle}
      flexDirection="column"
      overflow="hidden"
    >
      {needsScroll ? (
        <scrollbox
          height={contentHeight}
          stickyScroll={true}
          stickyStart="top"
          style={{ flexDirection: "column" }}
        >
          {rows}
        </scrollbox>
      ) : (
        <box height={contentHeight} style={{ flexDirection: "column" }}>
          {rows}
        </box>
      )}
    </box>
  );
}, (prev, next) => {
  if (prev.width !== next.width || prev.height !== next.height) return false;
  if (prev.items === next.items) return true;
  if (prev.items.length !== next.items.length) return false;
  return prev.items.every((item, i) => {
    const ni = next.items[i];
    return (
      item.id === ni.id &&
      item.status === ni.status &&
      item.filesChanged === ni.filesChanged &&
      item.queuePosition === ni.queuePosition &&
      item.error === ni.error
    );
  });
});
