import { memo, type ReactNode } from "react";
import type { EngineState } from "../../engine/types.js";
import type { NavMode } from "../types.js";
import { colors, statusIndicators } from "../theme.js";
import { formatTokenCount } from "../../engine/tokens.js";

interface StatusBarProps {
  state: EngineState;
  iteration: number;
  agentName: string;
  elapsedMs: number;
  width: number;
  currentPhase?: string | null;
  navMode?: NavMode;
  currentTaskTokens?: number | null;
}

const STATE_DISPLAY: Record<EngineState, { label: string; color: string; indicator: string }> = {
  idle: { label: "IDLE", color: colors.fg.muted, indicator: statusIndicators.idle },
  executing: { label: "RUNNING", color: colors.status.success, indicator: statusIndicators.executing },
  paused: { label: "PAUSED", color: colors.status.warning, indicator: statusIndicators.paused },
  blocked: { label: "BLOCKED", color: colors.status.error, indicator: statusIndicators.blocked },
  completed: { label: "DONE", color: colors.status.success, indicator: statusIndicators.completed },
  failed: { label: "FAILED", color: colors.status.error, indicator: statusIndicators.failed },
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
}: StatusBarProps): ReactNode {
  const display = STATE_DISPLAY[state];
  const elapsed = Math.round(elapsedMs / 1000);

  const navHints = navMode === "output-scroll"
    ? "j/k:scroll  esc:back  q:quit"
    : "j/k:tasks  enter:scroll  p:pause  d:dashboard  h:history  q:quit";

  const tokenDisplay = currentTaskTokens != null && currentTaskTokens > 0
    ? `${formatTokenCount(currentTaskTokens)} tok`
    : "N/A";

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
  Math.floor(prev.elapsedMs / 1000) === Math.floor(next.elapsedMs / 1000),
);
