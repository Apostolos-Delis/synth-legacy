import { memo, useState, useEffect, type ReactNode } from "react";
import { SPINNER_FRAMES, boldAttr, colors } from "../theme.js";

export type ConflictFileStatus = "pending" | "ai-resolving" | "resolved" | "failed";

export interface ConflictFile {
  path: string;
  status: ConflictFileStatus;
}

export interface ConflictInfo {
  taskId: string;
  taskTitle: string;
  files: ConflictFile[];
  summary: { resolved: number; failed: number } | null;
}

interface ConflictResolutionPanelProps {
  conflict: ConflictInfo | null;
  width: number;
  height: number;
}

const STATUS_LABEL: Record<ConflictFileStatus, string> = {
  "pending": "pending",
  "ai-resolving": "resolving",
  "resolved": "resolved",
  "failed": "failed",
};

const STATUS_COLOR: Record<ConflictFileStatus, string> = {
  "pending": colors.fg.muted,
  "ai-resolving": colors.status.warning,
  "resolved": colors.status.success,
  "failed": colors.status.error,
};

const STATUS_ICON: Record<ConflictFileStatus, string> = {
  "pending": "\u25CB",     // ○
  "ai-resolving": "",      // placeholder — spinner rendered inline
  "resolved": "\u2713",    // ✓
  "failed": "\u2717",      // ✗
};

function FileRow({
  file,
  pathMaxLen,
  spinnerFrame,
}: {
  file: ConflictFile;
  pathMaxLen: number;
  spinnerFrame: number;
}): ReactNode {
  const truncatedPath =
    file.path.length > pathMaxLen
      ? "..." + file.path.slice(file.path.length - pathMaxLen + 3)
      : file.path;
  const paddedPath = truncatedPath.padEnd(pathMaxLen);
  const label = STATUS_LABEL[file.status].padEnd(9);

  const icon =
    file.status === "ai-resolving"
      ? SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]
      : STATUS_ICON[file.status];

  return (
    <text>
      <span fg={STATUS_COLOR[file.status]}>{icon}</span>
      {" "}
      <span fg={colors.fg.secondary}>{paddedPath}</span>
      {" "}
      <span fg={STATUS_COLOR[file.status]}>{label}</span>
    </text>
  );
}

export const ConflictResolutionPanel = memo(function ConflictResolutionPanel({
  conflict,
  width,
  height,
}: ConflictResolutionPanelProps): ReactNode {
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  const hasResolving = conflict?.files.some((f) => f.status === "ai-resolving") ?? false;

  useEffect(() => {
    if (!hasResolving) return;
    const interval = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(interval);
  }, [hasResolving]);

  // AC #5: Panel disappears when conflict resolved/aborted (null = no conflict)
  if (!conflict) return null;

  const { taskId, taskTitle, files, summary } = conflict;

  const titleMaxLen = Math.max(20, width - 10);
  const truncatedTitle =
    taskTitle.length > titleMaxLen
      ? taskTitle.slice(0, titleMaxLen - 3) + "..."
      : taskTitle;

  // AC #3: Show which task caused the conflict
  const headerTitle = `Conflict: ${taskId}`;

  // AC #2: File path budget
  const pathMaxLen = Math.max(10, width - 16);

  const innerHeight = height - 2; // borders
  const needsScroll = files.length + 2 > innerHeight; // +2 for task context + summary lines

  const rows: ReactNode[] = [];

  // AC #3: Task context line
  rows.push(
    <text key="task-ctx">
      <span fg={colors.fg.muted}>{"task "}</span>
      <span fg={colors.accent.primary} attributes={boldAttr()}>{taskId}</span>
      <span fg={colors.fg.muted}>{" \u2014 "}</span>
      <span fg={colors.fg.secondary}>{truncatedTitle}</span>
    </text>,
  );

  // AC #2: Conflicted file list with per-file status
  for (const file of files) {
    rows.push(
      <FileRow
        key={file.path}
        file={file}
        pathMaxLen={pathMaxLen}
        spinnerFrame={spinnerFrame}
      />,
    );
  }

  // AC #4: Summary on resolution
  if (summary) {
    rows.push(
      <text key="summary">
        <span fg={colors.fg.muted}>{"\u2500".repeat(Math.min(20, width - 4))}</span>
      </text>,
    );
    rows.push(
      <text key="summary-counts">
        <span fg={colors.status.success}>{`${summary.resolved} resolved`}</span>
        <span fg={colors.fg.muted}>{", "}</span>
        <span fg={summary.failed > 0 ? colors.status.error : colors.fg.muted}>
          {`${summary.failed} failed`}
        </span>
      </text>,
    );
  }

  const content = needsScroll ? (
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
  );

  return (
    <box
      width={width}
      height={height}
      border={true}
      borderColor={hasResolving ? colors.border.active : colors.status.error}
      title={headerTitle}
      flexDirection="column"
    >
      {content}
    </box>
  );
}, (prev, next) => {
  if (prev.width !== next.width || prev.height !== next.height) return false;
  if (prev.conflict === next.conflict) return true;
  if (!prev.conflict || !next.conflict) return false;
  if (prev.conflict.taskId !== next.conflict.taskId) return false;
  if (prev.conflict.files.length !== next.conflict.files.length) return false;
  const prevSummary = prev.conflict.summary;
  const nextSummary = next.conflict.summary;
  if (prevSummary !== nextSummary) {
    if (!prevSummary || !nextSummary) return false;
    if (prevSummary.resolved !== nextSummary.resolved || prevSummary.failed !== nextSummary.failed) return false;
  }
  return prev.conflict.files.every((f, i) => {
    const nf = next.conflict!.files[i];
    return f.path === nf.path && f.status === nf.status;
  });
});
