import { useMemo, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { Task } from "../../tasks/types.js";
import { colors, markdownSyntaxStyle } from "../theme.js";
import { PhaseIndicator } from "./PhaseIndicator.js";
import { TaskDetailHeader } from "./TaskDetailHeader.js";

const MIN_OUTPUT_HEIGHT = 10;

function wrapLineCount(text: string, width: number): number {
  if (width <= 0 || text.length === 0) return 1;
  return Math.max(1, Math.ceil(text.length / width));
}

function calcHeaderHeight(task: Task, width: number, terminalHeight: number, paneHeight: number): number {
  // Usable text width inside bordered box
  const innerWidth = Math.max(1, width - 6);

  // Lines: border(2) + title(1) + description(N) + blank separator(1) + criteria(M)
  const descLines = wrapLineCount(task.description, innerWidth);
  const criteriaLines = task.acceptanceCriteria.length;
  const contentHeight = 2 + 1 + descLines + 1 + criteriaLines;

  const maxFromTerminal = Math.floor(terminalHeight * 0.4);
  const maxFromPane = paneHeight - MIN_OUTPUT_HEIGHT;

  return Math.max(4, Math.min(contentHeight, maxFromTerminal, maxFromPane));
}

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

  const { height: terminalHeight } = useTerminalDimensions();
  const headerHeight = useMemo(
    () => (task ? calcHeaderHeight(task, width, terminalHeight, height) : 0),
    [task, width, terminalHeight, height],
  );
  const maxOutputHeight = height - headerHeight;

  // Shrink the output box to fit content so we don't show a huge empty area
  // with a scrollbar when only a few lines are present.
  // +2 accounts for top/bottom border lines.
  const contentLines = output ? output.split("\n").length + 2 : MIN_OUTPUT_HEIGHT;
  const outputHeight = Math.max(MIN_OUTPUT_HEIGHT, Math.min(maxOutputHeight, contentLines));

  const waiting = isThinking && !output;

  return (
    <box width={width} height={height} flexDirection="column">
      {task && <TaskDetailHeader task={task} width={width} height={headerHeight} />}
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
