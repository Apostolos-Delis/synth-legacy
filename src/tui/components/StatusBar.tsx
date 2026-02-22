import type { ReactNode } from "react";
import type { EngineState } from "../../engine/types.js";
import { colors } from "../theme.js";

interface StatusBarProps {
  state: EngineState;
  iteration: number;
  agentName: string;
  elapsedMs: number;
  width: number;
}

const STATE_DISPLAY: Record<EngineState, { label: string; color: string }> = {
  idle: { label: "IDLE", color: colors.muted },
  executing: { label: "RUNNING", color: colors.success },
  paused: { label: "PAUSED", color: colors.warning },
  blocked: { label: "BLOCKED", color: colors.error },
  completed: { label: "DONE", color: colors.success },
  failed: { label: "FAILED", color: colors.error },
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
    <box width={width} height={1} flexDirection="row">
      <text>
        {` ${display.color}${display.label}${colors.reset} ${colors.muted}│${colors.reset} ${agentName} ${colors.muted}│${colors.reset} iter ${iteration} ${colors.muted}│${colors.reset} ${elapsed}s ${colors.muted}│ q:quit p:pause d:dashboard${colors.reset}`}
      </text>
    </box>
  );
}
