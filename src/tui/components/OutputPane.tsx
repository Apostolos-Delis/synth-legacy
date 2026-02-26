import { memo, useMemo, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { Task } from "../../tasks/types.js";
import { colors, markdownSyntaxStyle } from "../theme.js";
import { wrapText } from "../utils.js";
import { PhaseIndicator } from "./PhaseIndicator.js";
import { TaskDetailHeader } from "./TaskDetailHeader.js";

const MIN_OUTPUT_HEIGHT = 10;
const MIN_EMPTY_OUTPUT_HEIGHT = 4;
const TOOL_HEADER_RE = /^\[tool:(use|result)\]\s*(.*)$/;
const TOOL_INPUT_RE = /^\s{2}input:\s?(.*)$/;
const TOOL_OUTPUT_RE = /^\s{2}output:\s?(.*)$/;

function wrapLineCount(text: string, width: number): number {
  return wrapText(text, width).length;
}

type OutputBlock =
  | { type: "markdown"; content: string }
  | { type: "tool"; kind: "use" | "result"; name: string; id: string; input: string[]; output: string[] };

function parseOutputBlocks(output: string): OutputBlock[] {
  if (!output) return [];
  const lines = output.split("\n");
  const blocks: OutputBlock[] = [];
  let markdownLines: string[] = [];

  const flushMarkdown = () => {
    if (markdownLines.length === 0) return;
    blocks.push({ type: "markdown", content: markdownLines.join("\n") });
    markdownLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = TOOL_HEADER_RE.exec(line);
    if (!headerMatch) {
      markdownLines.push(line);
      continue;
    }

    flushMarkdown();

    const kind = headerMatch[1] as "use" | "result";
    const headerText = headerMatch[2]?.trim() ?? "";
    const parts = headerText.length > 0 ? headerText.split(/\s+/) : [];
    const name = parts.shift() ?? "tool";
    const id = parts.length > 0 ? ` ${parts.join(" ")}` : "";
    const input: string[] = [];
    const outputLines: string[] = [];

    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (TOOL_HEADER_RE.test(next)) {
        i = j - 1;
        break;
      }
      if (next.trim() === "") {
        i = j - 1;
        break;
      }
      const inputMatch = TOOL_INPUT_RE.exec(next);
      if (inputMatch) {
        input.push(inputMatch[1] ?? "");
        continue;
      }
      const outputMatch = TOOL_OUTPUT_RE.exec(next);
      if (outputMatch) {
        outputLines.push(outputMatch[1] ?? "");
        continue;
      }
      i = j - 1;
      break;
    }

    blocks.push({ type: "tool", kind, name, id, input, output: outputLines });
  }

  flushMarkdown();
  return blocks;
}

function calcHeaderHeight(
  task: Task,
  width: number,
  terminalHeight: number,
  paneHeight: number,
  minOutputHeight: number,
): number {
  // Usable text width inside bordered box
  const innerWidth = Math.max(1, width - 6);

  // Lines: border(2) + title(1) + blank(1) + description(N) + blank(1) + section header(0|1) + criteria(M)
  const descLines = wrapLineCount(task.description, innerWidth);
  const criteriaLines = task.acceptanceCriteria.length;
  const sectionHeaderHeight = criteriaLines > 0 ? 1 : 0;
  const contentHeight = 2 + 1 + 1 + descLines + 1 + sectionHeaderHeight + criteriaLines;

  const maxFromTerminal = Math.floor(terminalHeight * 0.5);
  const maxFromPane = paneHeight - minOutputHeight;

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
  outputFocused?: boolean;
  taskDetailFocused?: boolean;
  taskDetailScrollFocused?: boolean;
  autoScroll?: boolean;
}

export const OutputPane = memo(function OutputPane({
  output,
  width,
  height,
  isThinking = false,
  currentPhase,
  phaseStartTime,
  task,
  outputScrollFocused = false,
  outputFocused = false,
  taskDetailFocused = false,
  taskDetailScrollFocused = false,
  autoScroll = true,
}: OutputPaneProps): ReactNode {
  // Output is pre-stripped of ANSI codes in the event handler for minimal render-path latency.

  const { height: terminalHeight } = useTerminalDimensions();
  const outputIsEmpty = output.trim().length === 0 || output === "No output recorded";
  const minOutputHeight = outputIsEmpty && !isThinking ? MIN_EMPTY_OUTPUT_HEIGHT : MIN_OUTPUT_HEIGHT;
  const headerHeight = useMemo(
    () => (task ? calcHeaderHeight(task, width, terminalHeight, height, minOutputHeight) : 0),
    [task, width, terminalHeight, height, minOutputHeight],
  );
  const waiting = isThinking && !output;
  const outputBlocks = useMemo(() => parseOutputBlocks(output), [output]);

  return (
    <box width={width} height={height} flexDirection="column" overflow="hidden">
      {task && (
        <TaskDetailHeader
          task={task}
          width={width}
          height={headerHeight}
          focused={taskDetailFocused}
          scrollFocused={taskDetailScrollFocused}
        />
      )}
      <box
        width={width}
        flexGrow={1}
        border={true}
        borderColor={(outputScrollFocused || outputFocused) ? colors.border.active : colors.border.normal}
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
            outputBlocks.map((block, idx) => {
              if (block.type === "markdown") {
                return (
                  <markdown key={`md-${idx}`} content={block.content} syntaxStyle={markdownSyntaxStyle()} />
                );
              }
              const labelColor = block.kind === "use" ? colors.status.info : colors.status.success;
              const kindText = block.kind === "use" ? "tool use" : "tool result";
              return (
                <box key={`tool-${idx}`} style={{ flexDirection: "column" }}>
                  <text>
                    <span fg={labelColor}>{block.kind === "use" ? "\u2192" : "\u2190"}</span>
                    <span fg={colors.fg.muted}>{` ${kindText} `}</span>
                    <span fg={colors.accent.primary}>{block.name}</span>
                    {block.id && <span fg={colors.fg.dim}>{block.id}</span>}
                  </text>
                  {block.input.map((line, lineIdx) => (
                    <text key={`tool-in-${idx}-${lineIdx}`}>
                      <span fg={colors.fg.muted}>{"  input:"}</span>
                      <span fg={colors.fg.dim}>{` ${line}`}</span>
                    </text>
                  ))}
                  {block.output.map((line, lineIdx) => (
                    <text key={`tool-out-${idx}-${lineIdx}`}>
                      <span fg={colors.fg.muted}>{"  output:"}</span>
                      <span fg={colors.fg.dim}>{` ${line}`}</span>
                    </text>
                  ))}
                </box>
              );
            })
          )}
        </scrollbox>
      </box>
    </box>
  );
});
