import type { ReactNode } from "react";
import { colors } from "../theme.js";

interface HeaderProps {
  projectName: string;
  planId: string;
  iteration: number;
  maxIterations: number;
  agentName: string;
  elapsedMs: number;
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

export function Header({
  projectName,
  planId,
  iteration,
  maxIterations,
  agentName,
  elapsedMs,
  width,
}: HeaderProps): ReactNode {
  const left = ` ${colors.bold}synth${colors.reset} ${colors.muted}│${colors.reset} ${projectName} ${colors.muted}(${planId})${colors.reset}`;
  const right = `${colors.primary}${agentName}${colors.reset} ${colors.muted}│${colors.reset} iter ${iteration}/${maxIterations} ${colors.muted}│${colors.reset} ${formatElapsed(elapsedMs)}`;

  return (
    <box width={width} height={1} flexDirection="row">
      <text>{left}</text>
      <box flexGrow={1} />
      <text>{right} </text>
    </box>
  );
}
