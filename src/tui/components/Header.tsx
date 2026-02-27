import { memo, type ReactNode } from "react";
import { boldAttr, colors } from "../theme.js";
import { formatTokenCount } from "../../engine/tokens.js";
import { startSpan, endSpan } from "../profiler.js";

export interface ParallelHeaderInfo {
  currentWave: number;
  totalWaves: number;
  activeWorkers: number;
  mergedTasks: number;
  totalTasks: number;
}

export interface ParallelCompletionInfo {
  totalDurationMs: number;
  tasksCompleted: number;
  conflictsResolved: number;
}

interface HeaderProps {
  projectName: string;
  sessionId: string;
  iteration: number;
  maxIterations: number;
  agentName: string;
  elapsedMs: number;
  done: number;
  total: number;
  width: number;
  sessionTokens?: number | null;
  parallel?: ParallelHeaderInfo | null;
  parallelCompletion?: ParallelCompletionInfo | null;
}

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function miniProgressBar(done: number, total: number, width: number): string {
  if (total === 0) return "";
  const barWidth = Math.min(width, 10);
  const filled = Math.round((done / total) * barWidth);
  return "\u2593".repeat(filled) + "\u2591".repeat(barWidth - filled);
}

export const Header = memo(function Header({
  projectName,
  sessionId,
  iteration,
  maxIterations,
  agentName,
  elapsedMs,
  done,
  total,
  width,
  sessionTokens,
  parallel,
  parallelCompletion,
}: HeaderProps): ReactNode {
  const renderSpan = startSpan("Header");
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const tokenDisplay = sessionTokens != null && sessionTokens > 0
    ? `${formatTokenCount(sessionTokens)} tokens`
    : "N/A";

  // Parallel completion state: show summary stats
  if (parallelCompletion) {
    endSpan("Header", renderSpan);
    return (
      <box
        width={width}
        height={1}
        flexDirection="row"
        style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1, paddingRight: 1 }}
      >
        <text>
          <span fg={colors.accent.primary} attributes={boldAttr()}>synth</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.primary}>{projectName}</span>
          <span fg={colors.fg.muted}> ({sessionId})</span>
        </text>
        <box flexGrow={1} />
        <text>
          <span fg={colors.status.success}>{"\u2713"} Complete</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.secondary}>{formatElapsed(parallelCompletion.totalDurationMs)}</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.secondary}>{parallelCompletion.tasksCompleted} tasks</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.secondary}>{parallelCompletion.conflictsResolved} conflicts resolved</span>
        </text>
      </box>
    );
  }

  // Parallel active state: show wave/worker/merge info
  if (parallel) {
    endSpan("Header", renderSpan);
    return (
      <box
        width={width}
        height={1}
        flexDirection="row"
        style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1, paddingRight: 1 }}
      >
        <text>
          <span fg={colors.accent.primary} attributes={boldAttr()}>synth</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.primary}>{projectName}</span>
          <span fg={colors.fg.muted}> ({sessionId})</span>
        </text>
        <box flexGrow={1} />
        <text>
          <span fg={colors.accent.primary}>Parallel</span>
          <span fg={colors.fg.muted}>{": "}</span>
          <span fg={colors.fg.secondary}>Wave {parallel.currentWave}/{parallel.totalWaves}</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.secondary}>Workers: {parallel.activeWorkers} active</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.secondary}>Tasks: {parallel.mergedTasks}/{parallel.totalTasks} merged</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.secondary}>{tokenDisplay}</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.secondary}>{formatElapsed(elapsedMs)}</span>
        </text>
      </box>
    );
  }

  // Non-parallel mode: unchanged
  endSpan("Header", renderSpan);
  return (
    <box
      width={width}
      height={1}
      flexDirection="row"
      style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1, paddingRight: 1 }}
    >
      <text>
        <span fg={colors.accent.primary} attributes={boldAttr()}>synth</span>
        <span fg={colors.fg.muted}>{" │ "}</span>
        <span fg={colors.fg.primary}>{projectName}</span>
        <span fg={colors.fg.muted}> ({sessionId})</span>
      </text>
      <box flexGrow={1} />
      <text>
        <span fg={colors.status.success}>{miniProgressBar(done, total, 10)}</span>
        <span fg={colors.fg.muted}>{` ${pct}% │ `}</span>
        <span fg={colors.accent.primary}>{agentName}</span>
        <span fg={colors.fg.muted}>{" │ "}</span>
        <span fg={colors.fg.secondary}>iter {iteration}/{maxIterations}</span>
        <span fg={colors.fg.muted}>{" │ "}</span>
        <span fg={colors.fg.secondary}>{tokenDisplay}</span>
        <span fg={colors.fg.muted}>{" │ "}</span>
        <span fg={colors.fg.secondary}>{formatElapsed(elapsedMs)}</span>
      </text>
    </box>
  );
}, (prev, next) =>
  prev.projectName === next.projectName &&
  prev.sessionId === next.sessionId &&
  prev.iteration === next.iteration &&
  prev.maxIterations === next.maxIterations &&
  prev.agentName === next.agentName &&
  prev.done === next.done &&
  prev.total === next.total &&
  prev.width === next.width &&
  prev.sessionTokens === next.sessionTokens &&
  prev.parallel === next.parallel &&
  prev.parallelCompletion === next.parallelCompletion &&
  Math.floor(prev.elapsedMs / 1000) === Math.floor(next.elapsedMs / 1000),
);
