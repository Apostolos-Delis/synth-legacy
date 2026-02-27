import { memo, type ReactNode } from "react";
import type { EngineState } from "../../engine/types.js";
import type { NavMode } from "../types.js";
import { colors, statusIndicators } from "../theme.js";
import { formatTokenCount } from "../../engine/tokens.js";
import { startSpan, endSpan } from "../profiler.js";

export interface ParallelStatusInfo {
  recommendedWorkers: number;
  confidence: "high" | "medium" | "low";
  reason: string;
}

interface StatusBarProps {
  state: EngineState;
  iteration: number;
  agentName: string;
  elapsedMs: number;
  width: number;
  currentPhase?: string | null;
  navMode?: NavMode;
  currentTaskTokens?: number | null;
  parallelStatus?: ParallelStatusInfo | null;
  exitArmed?: boolean;
}

const STATE_DISPLAY: Record<EngineState, { label: string; color: string; indicator: string }> = {
  idle: { label: "IDLE", color: colors.fg.muted, indicator: statusIndicators.idle },
  executing: { label: "RUNNING", color: colors.status.success, indicator: statusIndicators.executing },
  reviewing: { label: "REVIEWING", color: colors.accent.primary, indicator: statusIndicators.reviewing },
  paused: { label: "PAUSED", color: colors.status.warning, indicator: statusIndicators.paused },
  blocked: { label: "BLOCKED", color: colors.status.error, indicator: statusIndicators.blocked },
  completed: { label: "DONE", color: colors.status.success, indicator: statusIndicators.completed },
  failed: { label: "FAILED", color: colors.status.error, indicator: statusIndicators.failed },
};

const CONFIDENCE_COLOR: Record<string, string> = {
  high: colors.status.success,
  medium: colors.status.warning,
  low: colors.fg.muted,
};

export const StatusBar = memo(function StatusBar({
  state,
  iteration,
  agentName,
  elapsedMs,
  width,
  currentPhase,
  navMode,
  currentTaskTokens,
  parallelStatus,
  exitArmed = false,
}: StatusBarProps): ReactNode {
  const renderSpan = startSpan("StatusBar");
  const display = STATE_DISPLAY[state];
  const elapsed = Math.round(elapsedMs / 1000);

  const isParallel = parallelStatus != null;
  const parallelExtras = isParallel ? "  g:graph  l:logs" : "";
  const navHints = exitArmed
    ? "Press q/esc again to quit"
    : navMode === "output-scroll"
      ? isParallel
        ? `j/k:scroll  w:workers  m:merge  tab:next  esc:back  q:quit${parallelExtras}`
        : "j/k:scroll  esc:back  q:quit"
    : navMode === "task-detail-scroll"
      ? isParallel
        ? `j/k:scroll  w:workers  m:merge  tab:next  esc:back  q:quit${parallelExtras}`
        : "j/k:scroll  esc:back  q:quit"
      : navMode === "detail-select"
        ? isParallel
          ? `j/k:focus  enter:scroll  w:workers  m:merge  tab:next  esc:back  q:quit${parallelExtras}`
          : "j/k:focus  enter:scroll  esc:back  q:quit"
        : navMode === "worker-panel"
          ? `w:output  m:merge  tab:next  esc:back  q:quit${parallelExtras}`
          : navMode === "merge-panel"
            ? `m:back  w:workers  tab:next  esc:back  q:quit${parallelExtras}`
            : navMode === "conflict-panel"
              ? `tab:next  esc:back  q:quit${parallelExtras}`
              : isParallel
                ? `j/k:tasks  enter:scroll  w:workers  m:merge  p:pause  d:dashboard  q:quit${parallelExtras}`
                : "j/k:tasks  enter:scroll  h:history  p:pause  d:dashboard  q:quit";

  const tokenDisplay = currentTaskTokens != null && currentTaskTokens > 0
    ? `${formatTokenCount(currentTaskTokens)} tok`
    : "N/A";

  endSpan("StatusBar", renderSpan);
  return (
    <box
      width={width}
      height={1}
      flexDirection="row"
      style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}
    >
      <text>
        <span fg={display.color}>{display.indicator} {display.label}</span>
        <span fg={colors.fg.muted}>{" │ "}</span>
        <span fg={colors.fg.secondary}>{agentName}</span>
        <span fg={colors.fg.muted}>{" │ "}</span>
        <span fg={colors.fg.secondary}>iter {iteration}</span>
        <span fg={colors.fg.muted}>{" │ "}</span>
        <span fg={colors.fg.secondary}>{elapsed}s</span>
        <span fg={colors.fg.muted}>{" │ "}</span>
        <span fg={tokenDisplay === "N/A" ? colors.fg.muted : colors.accent.secondary}>{tokenDisplay}</span>
        {currentPhase && (
          <>
            <span fg={colors.fg.muted}>{" │ "}</span>
            <span fg={colors.accent.primary}>{currentPhase}</span>
          </>
        )}
        {parallelStatus && (
          <>
            <span fg={colors.fg.muted}>{" │ "}</span>
            <span fg={CONFIDENCE_COLOR[parallelStatus.confidence] ?? colors.fg.muted}>
              {parallelStatus.recommendedWorkers}w ({parallelStatus.confidence})
            </span>
            <span fg={colors.fg.muted}>{" "}</span>
            <span fg={colors.fg.dim}>{parallelStatus.reason}</span>
          </>
        )}
        <span fg={colors.fg.muted}>{" │ "}</span>
        <span fg={colors.fg.muted}>{navHints}</span>
      </text>
    </box>
  );
}, (prev, next) =>
  prev.state === next.state &&
  prev.iteration === next.iteration &&
  prev.agentName === next.agentName &&
  prev.width === next.width &&
  prev.currentPhase === next.currentPhase &&
  prev.navMode === next.navMode &&
  prev.currentTaskTokens === next.currentTaskTokens &&
  prev.parallelStatus === next.parallelStatus &&
  prev.exitArmed === next.exitArmed &&
  Math.floor(prev.elapsedMs / 1000) === Math.floor(next.elapsedMs / 1000),
);
