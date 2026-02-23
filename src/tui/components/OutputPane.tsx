import type { ReactNode } from "react";
import type { Task } from "../../tasks/types.js";
import { colors, markdownSyntaxStyle } from "../theme.js";
import { PhaseIndicator } from "./PhaseIndicator.js";
import { TaskDetailHeader } from "./TaskDetailHeader.js";

const HEADER_HEIGHT = 10;

interface OutputPaneProps {
  output: string;
  width: number;
  height: number;
  isThinking?: boolean;
  currentPhase?: string | null;
  phaseStartTime?: number | null;
  task?: Task | null;
  outputScrollFocused?: boolean;
  autoScroll?: boolean;
}

export function OutputPane({ output, width, height, isThinking = false, currentPhase, phaseStartTime, task, outputScrollFocused = false, autoScroll = true }: OutputPaneProps): ReactNode {
  // Output is pre-stripped of ANSI codes in the event handler for minimal render-path latency.

  const headerHeight = task ? HEADER_HEIGHT : 0;
  const outputHeight = height - headerHeight;
  const waiting = isThinking && !output;

  return (
    <box width={width} height={height} flexDirection="column">
      {task && <TaskDetailHeader task={task} width={width} height={HEADER_HEIGHT} />}
      <box
        width={width}
        height={outputHeight}
        border={true}
        borderColor={outputScrollFocused ? colors.border.active : colors.border.normal}
        title={outputScrollFocused ? "Output (scrolling \u2014 Esc to exit)" : "Output"}
        flexDirection="column"
      >
        <scrollbox
          flexGrow={1}
          focused={outputScrollFocused}
          stickyScroll={autoScroll}
          stickyStart="bottom"
          viewportCulling={true}
          style={{ flexDirection: "column" }}
        >
          {waiting ? (
            currentPhase && phaseStartTime ? (
              <PhaseIndicator phase={currentPhase} startTime={phaseStartTime} />
            ) : (
              <text>
                <span fg={colors.fg.muted}>Agent is working...</span>
              </text>
            )
          ) : (
            <markdown content={output} syntaxStyle={markdownSyntaxStyle()} />
          )}
        </scrollbox>
      </box>
    </box>
  );
}
