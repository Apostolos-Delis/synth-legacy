import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { CompletionSummary } from "./types.js";
import { boldAttr, colors, statusIndicators, STATUS_COLORS_HEX } from "./theme.js";
import { Footer } from "./components/Footer.js";
import { wrapText } from "./utils.js";
import { formatDuration } from "../utils/format.js";

interface CompletionViewProps {
  summary: CompletionSummary;
  showFinalizePrompt?: boolean;
}

function padLine(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length >= width) return "";
  return " ".repeat(width - text.length);
}

export function CompletionView({ summary, showFinalizePrompt }: CompletionViewProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const { progress, tasks, commits } = summary;
  const innerWidth = Math.max(1, width - 2);
  const headerText = `Completion Summary | ${summary.projectName} (${summary.sessionId})`;
  const headerPad = padLine(headerText, innerWidth);
  const statsText = `Duration: ${formatDuration(summary.totalDurationMs)}  Iterations: ${summary.totalIterations}  Agent: ${summary.agentName}`;
  const statsPad = padLine(statsText, innerWidth);
  const progressText = `\u2714 ${progress.done} done  \u2718 ${progress.failed} failed  \u25CB ${progress.open} open  \u25D4 ${progress.inProgress} in progress`;
  const progressPad = padLine(progressText, innerWidth);
  const tableHeaderText = `${"ID".padEnd(8)} ${"Title".padEnd(40)} Status`;
  const tableHeaderPad = padLine(tableHeaderText, innerWidth);
  const summaryText = `Summary saved to: ${summary.summaryFilePath}`;
  const summaryPad = padLine(summaryText, innerWidth);
  const blankLine = padLine("", innerWidth);

  const commitRows: ReactNode[] = [];
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const firstSpace = commit.indexOf(" ");
    const hash = firstSpace === -1 ? commit : commit.slice(0, firstSpace);
    const subject = firstSpace === -1 ? "" : commit.slice(firstSpace + 1);
    const indent = "  ";
    const prefix = `${indent}${hash}${subject ? " " : ""}`;
    const subjectWidth = Math.max(1, innerWidth - prefix.length);
    const subjectLines = subject ? wrapText(subject, subjectWidth) : [""];

    for (let lineIndex = 0; lineIndex < subjectLines.length; lineIndex++) {
      const line = subjectLines[lineIndex];
      const linePrefix = lineIndex === 0 ? prefix : " ".repeat(prefix.length);
      const fullLine = `${linePrefix}${line}`;
      const linePad = padLine(fullLine, innerWidth);
      commitRows.push(
        <text key={`commit-${i}-${lineIndex}`}>
          {lineIndex === 0 ? (
            <>
              <span fg={colors.fg.secondary}>{indent}{hash}</span>
              {subject ? <span fg={colors.fg.muted}>{" "}</span> : null}
              {subject ? <span fg={colors.fg.primary}>{line}</span> : null}
            </>
          ) : (
            <>
              <span fg={colors.fg.muted}>{linePrefix}</span>
              <span fg={colors.fg.primary}>{line}</span>
            </>
          )}
          <span>{linePad}</span>
        </text>,
      );
    }
  }

  return (
    <box width={width} height={height} flexDirection="column">
      {/* Header */}
      <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text>
          <span fg={colors.status.success} attributes={boldAttr()}>Completion Summary</span>
          <span fg={colors.fg.muted}>{" | "}</span>
          <span fg={colors.fg.secondary}>{summary.projectName}</span>
          <span fg={colors.fg.muted}>{" ("}</span>
          <span fg={colors.accent.primary}>{summary.sessionId}</span>
          <span fg={colors.fg.muted}>{")"}</span>
          <span>{headerPad}</span>
        </text>
      </box>

      {/* Stats line */}
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.fg.muted}>{"Duration: "}</span>
          <span fg={colors.fg.primary} attributes={boldAttr()}>{formatDuration(summary.totalDurationMs)}</span>
          <span fg={colors.fg.muted}>{"  Iterations: "}</span>
          <span fg={colors.fg.primary} attributes={boldAttr()}>{String(summary.totalIterations)}</span>
          <span fg={colors.fg.muted}>{"  Agent: "}</span>
          <span fg={colors.fg.secondary}>{summary.agentName}</span>
          <span>{statsPad}</span>
        </text>
      </box>

      {/* Progress line */}
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.status.success}>{"\u2714 "}{String(progress.done)}{" done  "}</span>
          <span fg={colors.status.error}>{"\u2718 "}{String(progress.failed)}{" failed  "}</span>
          <span fg={colors.fg.muted}>{"\u25CB "}{String(progress.open)}{" open  "}</span>
          <span fg={colors.accent.primary}>{"\u25D4 "}{String(progress.inProgress)}{" in progress"}</span>
          <span>{progressPad}</span>
        </text>
      </box>

      {/* Separator */}
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.border.normal}>{"\u2500".repeat(Math.min(width - 2, 80))}</span>
        </text>
      </box>

      {/* Task table header */}
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.fg.muted} attributes={boldAttr()}>
            {"ID".padEnd(8)} {"Title".padEnd(40)} Status
          </span>
          <span>{tableHeaderPad}</span>
        </text>
      </box>

      {/* Task list */}
      <scrollbox flexGrow={1} stickyScroll={true} stickyStart="top" style={{ flexDirection: "column", paddingLeft: 1 }}>
        {tasks.map((task) => {
          const icon = statusIndicators[task.status] ?? "?";
          const statusColor = STATUS_COLORS_HEX[task.status] ?? colors.fg.muted;
          const title =
            task.title.length > 40
              ? task.title.slice(0, 37) + "..."
              : task.title.padEnd(40);

          return (
            <text key={task.id}>
              <span fg={colors.fg.secondary}>{task.id.padEnd(8)}</span>
              {" "}
              <span fg={colors.fg.primary}>{title}</span>
              {" "}
              <span fg={statusColor}>{icon} {task.status}</span>
            </text>
          );
        })}

        {/* Separator before commits */}
        {commits.length > 0 && (
          <>
            <text>
              <span>{blankLine}</span>
            </text>
            <text>
              <span fg={colors.border.normal}>{"\u2500".repeat(Math.min(width - 2, 80))}</span>
            </text>
            <text>
              <span fg={colors.fg.muted} attributes={boldAttr()}>Commits ({String(commits.length)})</span>
            </text>
            {commitRows}
          </>
        )}

        {/* Summary file path */}
        <text>
          <span>{blankLine}</span>
        </text>
        <text>
          <span fg={colors.fg.muted}>{"Summary saved to: "}</span>
          <span fg={colors.accent.primary}>{summary.summaryFilePath}</span>
          <span>{summaryPad}</span>
        </text>
      </scrollbox>

      {showFinalizePrompt && (
        <box style={{ paddingLeft: 1 }}>
          <text>
            <span fg={colors.status.success} attributes={boldAttr()}>
              {"All tasks complete. "}
            </span>
            <span fg={colors.fg.secondary}>
              {"Press "}
            </span>
            <span fg={colors.accent.primary} attributes={boldAttr()}>f</span>
            <span fg={colors.fg.secondary}>
              {" to start finalize review, or "}
            </span>
            <span fg={colors.accent.primary} attributes={boldAttr()}>q</span>
            <span fg={colors.fg.secondary}>{" to exit."}</span>
          </text>
        </box>
      )}

      <Footer view={showFinalizePrompt ? "completion-finalize" : "completion"} width={width} />
    </box>
  );
}
