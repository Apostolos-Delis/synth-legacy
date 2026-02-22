import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { CompletionSummary } from "./types.js";
import { boldAttr, colors, statusIndicators, STATUS_COLORS_HEX } from "./theme.js";
import { Footer } from "./components/Footer.js";
import { formatDuration } from "../utils/format.js";

interface CompletionViewProps {
  summary: CompletionSummary;
}

export function CompletionView({ summary }: CompletionViewProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const { progress, tasks, commits } = summary;

  return (
    <box width={width} height={height} flexDirection="column">
      {/* Header */}
      <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text>
          <span fg={colors.status.success} attributes={boldAttr()}>Completion Summary</span>
          <span fg={colors.fg.muted}>{" | "}</span>
          <span fg={colors.fg.secondary}>{summary.projectName}</span>
          <span fg={colors.fg.muted}>{" ("}</span>
          <span fg={colors.accent.primary}>{summary.planId}</span>
          <span fg={colors.fg.muted}>{")"}</span>
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
        </text>
      </box>

      {/* Progress line */}
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.status.success}>{"\u2714 "}{String(progress.done)} done</span>
          {"  "}
          <span fg={colors.status.error}>{"\u2718 "}{String(progress.failed)} failed</span>
          {"  "}
          <span fg={colors.fg.muted}>{"\u25CB "}{String(progress.open)} open</span>
          {"  "}
          <span fg={colors.accent.primary}>{"\u25D4 "}{String(progress.inProgress)} in progress</span>
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
            <text>{""}</text>
            <text>
              <span fg={colors.border.normal}>{"\u2500".repeat(Math.min(width - 2, 80))}</span>
            </text>
            <text>
              <span fg={colors.fg.muted} attributes={boldAttr()}>Commits ({String(commits.length)})</span>
            </text>
            {commits.map((commit, i) => (
              <text key={`commit-${i}`}>
                <span fg={colors.fg.secondary}>{"  "}{commit}</span>
              </text>
            ))}
          </>
        )}

        {/* Summary file path */}
        <text>{""}</text>
        <text>
          <span fg={colors.fg.muted}>{"Summary saved to: "}</span>
          <span fg={colors.accent.primary}>{summary.summaryFilePath}</span>
        </text>
      </scrollbox>

      <Footer view="completion" width={width} />
    </box>
  );
}
