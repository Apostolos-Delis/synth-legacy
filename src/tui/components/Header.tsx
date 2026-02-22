import type { ReactNode } from "react";
import { colors } from "../theme.js";

interface HeaderProps {
  projectName: string;
  planId: string;
  iteration: number;
  maxIterations: number;
  agentName: string;
  elapsedMs: number;
  done: number;
  total: number;
  width: number;
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

export function Header({
  projectName,
  planId,
  iteration,
  maxIterations,
  agentName,
  elapsedMs,
  done,
  total,
  width,
}: HeaderProps): ReactNode {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <box
      width={width}
      height={1}
      flexDirection="row"
      style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1, paddingRight: 1 }}
    >
      <text>
        <span fg={colors.accent.primary} attributes={1}>synth</span>
        <span fg={colors.fg.muted}>{" │ "}</span>
        <span fg={colors.fg.primary}>{projectName}</span>
        <span fg={colors.fg.muted}> ({planId})</span>
      </text>
      <box flexGrow={1} />
      <text>
        <span fg={colors.status.success}>{miniProgressBar(done, total, 10)}</span>
        <span fg={colors.fg.muted}>{` ${pct}% │ `}</span>
        <span fg={colors.accent.primary}>{agentName}</span>
        <span fg={colors.fg.muted}>{" │ "}</span>
        <span fg={colors.fg.secondary}>iter {iteration}/{maxIterations}</span>
        <span fg={colors.fg.muted}>{" │ "}</span>
        <span fg={colors.fg.secondary}>{formatElapsed(elapsedMs)}</span>
      </text>
    </box>
  );
}
