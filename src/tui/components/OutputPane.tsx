import { memo, useMemo, type ReactNode } from "react";
import type { Task } from "../../tasks/types.js";
import { colors } from "../theme.js";
import { startSpan, endSpan } from "../profiler.js";
import { PhaseIndicator } from "./PhaseIndicator.js";
import { TaskDetailHeader } from "./TaskDetailHeader.js";

const MIN_OUTPUT_HEIGHT = 10;
const MIN_EMPTY_OUTPUT_HEIGHT = 4;
const MIN_HEADER_HEIGHT = 4;
const TOOL_HEADER_RE = /^\[tool:(use|result)\]\s*(.*)$/;
const TOOL_INPUT_RE = /^\s{2}input:\s?(.*)$/;
const TOOL_OUTPUT_RE = /^\s{2}output:\s?(.*)$/;

const FLEX_COLUMN_STYLE = { flexDirection: "column" } as const;
const VERTICAL_SCROLLBAR_OPTIONS = {
  showArrows: false,
  trackOptions: {
    backgroundColor: colors.bg.secondary,
    foregroundColor: colors.border.normal,
  },
} as const;

type OutputBlock =
  | { type: "markdown"; content: string }
  | { type: "tool"; kind: "use" | "result"; name: string; id: string; input: string[]; output: string[] };

function _expandToolLine(line: string, label: "input" | "output"): string[] {
  const trimmed = line.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) return [line];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [line];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [line];

  const obj = parsed as Record<string, unknown>;
  const lines: string[] = [];

  const pushValue = (key: string, value: unknown, prefixKey: boolean) => {
    if (value == null) {
      lines.push(prefixKey ? `${key}: null` : "null");
      return;
    }
    if (typeof value === "string") {
      if (key === "output" || key === "stdout" || key === "stderr") {
        const parts = value.split("\n");
        if (parts.length === 0) {
          lines.push(prefixKey ? `${key}:` : "");
          return;
        }
        for (const part of parts) {
          if (prefixKey) {
            lines.push(`${key}: ${part}`);
          } else {
            lines.push(part);
          }
        }
        return;
      }
      lines.push(prefixKey ? `${key}: ${value}` : value);
      return;
    }
    try {
      const serialized = JSON.stringify(value);
      lines.push(prefixKey ? `${key}: ${serialized}` : serialized);
    } catch {
      lines.push(prefixKey ? `${key}: ${String(value)}` : String(value));
    }
  };

  if (label === "input") {
    if (typeof obj.command === "string") {
      lines.push(obj.command);
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === "command") continue;
      pushValue(key, value, true);
    }
  } else {
    if (typeof obj.output === "string") {
      pushValue("output", obj.output, false);
    }
    if (typeof obj.stdout === "string" && obj.stdout !== obj.output) {
      pushValue("stdout", obj.stdout, true);
    }
    if (typeof obj.stderr === "string") {
      pushValue("stderr", obj.stderr, true);
    }
    if ("exitCode" in obj) {
      pushValue("exitCode", obj.exitCode, true);
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === "output" || key === "stdout" || key === "stderr" || key === "exitCode") continue;
      pushValue(key, value, true);
    }
  }

  return lines.length > 0 ? lines : [line];
}

function _parseOutputBlocks(output: string): OutputBlock[] {
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
  paneHeight: number,
  minOutputHeight: number,
): number {
  const maxFromPane = Math.max(0, paneHeight - minOutputHeight);
  const halfHeight = Math.floor(paneHeight / 2);
  const desired = Math.max(MIN_HEADER_HEIGHT, halfHeight);
  return Math.max(0, Math.min(maxFromPane, desired));
}

interface OutputPaneProps {
  output: string;
  outputCacheKey?: string;
  outputSignature?: string;
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
  outputCacheKey: _outputCacheKey,
  outputSignature: _outputSignature,
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
  autoScroll: _autoScroll = true,
}: OutputPaneProps): ReactNode {
  const renderSpan = startSpan("OutputPane");

  const outputIsEmpty = output.trim().length === 0 || output === "No output recorded";
  const minOutputHeight = outputIsEmpty && !isThinking ? MIN_EMPTY_OUTPUT_HEIGHT : MIN_OUTPUT_HEIGHT;
  const headerHeight = useMemo(
    () => (task ? calcHeaderHeight(height, minOutputHeight) : 0),
    [task, height, minOutputHeight],
  );
  const outputHeight = Math.max(1, height - headerHeight);
  const outputScrollHeight = Math.max(1, outputHeight - 2);
  const waiting = isThinking && !output;

  // Simple line-based rendering — same approach as ralph-tui.
  // Split output into lines and render each as a <text> element.
  // No block parsing, no markdown, no JSON expansion — just lines.
  const TOOL_LINE_RE = /^\[tool:(use|result)\]\s*(.*)/;
  const outputLines = useMemo(() => {
    // Truncate to visible tail
    const maxChars = Math.max(1500, outputScrollHeight * 120);
    const src = output.length > maxChars
      ? output.slice(output.indexOf("\n", output.length - maxChars) + 1 || output.length - maxChars)
      : output;
    return src.split("\n");
  }, [output, outputScrollHeight]);

  endSpan("OutputPane", renderSpan);
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
        height={outputHeight}
        border={true}
        borderColor={(outputScrollFocused || outputFocused) ? colors.border.active : colors.border.normal}
        title={outputScrollFocused ? "Output (scrolling \u2014 Esc to exit)" : "Output"}
        flexDirection="column"
        overflow="hidden"
      >
        <scrollbox
          height={outputScrollHeight}
          focused={outputScrollFocused}
          stickyStart="bottom"
          viewportCulling
          verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
          style={FLEX_COLUMN_STYLE}
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
            <box style={FLEX_COLUMN_STYLE}>
              {outputLines.map((line, i) => {
                const toolMatch = TOOL_LINE_RE.exec(line);
                if (toolMatch) {
                  const kind = toolMatch[1];
                  const rest = toolMatch[2] ?? "";
                  return (
                    <text key={i}>
                      <span fg={kind === "use" ? colors.status.info : colors.status.success}>{`[tool:${kind}]`}</span>
                      <span fg={colors.fg.secondary}>{` ${rest}`}</span>
                    </text>
                  );
                }
                return <text key={i} fg={colors.fg.secondary}>{line}</text>;
              })}
            </box>
          )}
        </scrollbox>
      </box>
    </box>
  );
});
