import type { ReactNode } from "react";
import type { EngineState } from "../../engine/types.js";
import { colors, statusIndicators } from "../theme.js";

interface StatusBarProps {
  state: EngineState;
  iteration: number;
  agentName: string;
  elapsedMs: number;
  width: number;
}

const STATE_DISPLAY: Record<EngineState, { label: string; color: string; indicator: string }> = {
  idle: { label: "IDLE", color: colors.fg.muted, indicator: statusIndicators.idle },
  executing: { label: "RUNNING", color: colors.status.success, indicator: statusIndicators.executing },
  paused: { label: "PAUSED", color: colors.status.warning, indicator: statusIndicators.paused },
  blocked: { label: "BLOCKED", color: colors.status.error, indicator: statusIndicators.blocked },
  completed: { label: "DONE", color: colors.status.success, indicator: statusIndicators.completed },
  failed: { label: "FAILED", color: colors.status.error, indicator: statusIndicators.failed },
};

export function StatusBar({
  state,
  iteration,
  agentName,
  elapsedMs,
  width,
}: StatusBarProps): ReactNode {
  const display = STATE_DISPLAY[state];
  const elapsed = Math.round(elapsedMs / 1000);

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
        <span fg={colors.fg.muted}>q:quit  p:pause  d:dashboard</span>
      </text>
    </box>
  );
}
