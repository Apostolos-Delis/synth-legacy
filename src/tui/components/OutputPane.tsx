import type { ReactNode } from "react";
import { colors } from "../theme.js";
import { PhaseIndicator } from "./PhaseIndicator.js";

interface OutputPaneProps {
  output: string;
  width: number;
  height: number;
  isThinking?: boolean;
  currentPhase?: string | null;
  phaseStartTime?: number | null;
}

export function OutputPane({ output, width, height, isThinking = false, currentPhase, phaseStartTime }: OutputPaneProps): ReactNode {
  // Output is pre-stripped of ANSI codes in the event handler for minimal render-path latency.

  if (isThinking && !output) {
    return (
      <box
        width={width}
        height={height}
        border={true}
        borderColor={colors.border.normal}
        title="Output"
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
      >
        {currentPhase && phaseStartTime ? (
          <PhaseIndicator phase={currentPhase} startTime={phaseStartTime} />
        ) : (
          <text>
            <span fg={colors.fg.muted}>Agent is working...</span>
          </text>
        )}
      </box>
    );
  }

  const lines = output.split("\n");

  return (
    <box
      width={width}
      height={height}
      border={true}
      borderColor={colors.border.normal}
      title="Output"
      flexDirection="column"
    >
      <scrollbox
        flexGrow={1}
        stickyScroll={true}
        stickyStart="bottom"
        style={{ flexDirection: "column" }}
      >
        {lines.map((line, i) => (
          <text key={i}>
            <span fg={colors.fg.secondary}>{line}</span>
          </text>
        ))}
      </scrollbox>
    </box>
  );
}
