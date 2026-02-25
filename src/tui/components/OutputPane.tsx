import { memo, useMemo, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { Task } from "../../tasks/types.js";
import { colors, markdownSyntaxStyle } from "../theme.js";
import { wrapText } from "../utils.js";
import { PhaseIndicator } from "./PhaseIndicator.js";
import { TaskDetailHeader } from "./TaskDetailHeader.js";

const MIN_OUTPUT_HEIGHT = 10;

function wrapLineCount(text: string, width: number): number {
  return wrapText(text, width).length;
}

function calcHeaderHeight(task: Task, width: number, terminalHeight: number, paneHeight: number): number {
  // Usable text width inside bordered box
  const innerWidth = Math.max(1, width - 6);

  // Lines: border(2) + title(1) + description(N) + blank separator(1) + section header(0|1) + criteria(M)
  const descLines = wrapLineCount(task.description, innerWidth);
  const criteriaLines = task.acceptanceCriteria.length;
  const sectionHeaderHeight = criteriaLines > 0 ? 1 : 0;
  const contentHeight = 2 + 1 + descLines + 1 + sectionHeaderHeight + criteriaLines;

  const maxFromTerminal = Math.floor(terminalHeight * 0.5);
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

export const OutputPane = memo(function OutputPane({ output, width, height, isThinking = false, currentPhase, phaseStartTime, task, outputScrollFocused = false, autoScroll = true }: OutputPaneProps): ReactNode {
  // Output is pre-stripped of ANSI codes in the event handler for minimal render-path latency.

  const { height: terminalHeight } = useTerminalDimensions();
  const headerHeight = useMemo(
    () => (task ? calcHeaderHeight(task, width, terminalHeight, height) : 0),
    [task, width, terminalHeight, height],
  );
  const waiting = isThinking && !output;

  return (
    <box width={width} height={height} flexDirection="column" overflow="hidden">
      {task && <TaskDetailHeader task={task} width={width} height={headerHeight} />}
      <box
        width={width}
        flexGrow={1}
        border={true}
        borderColor={outputScrollFocused ? colors.border.active : colors.border.normal}
        title={outputScrollFocused ? "Output (scrolling \u2014 Esc to exit)" : "Output"}
        flexDirection="column"
        overflow="hidden"
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
});
