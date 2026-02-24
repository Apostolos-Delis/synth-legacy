import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { TuiState } from "./types.js";
import { boldAttr, colors, statusIndicators, STATUS_COLORS_HEX, PRIORITY_COLORS_HEX } from "./theme.js";
import { Footer } from "./components/Footer.js";
import { formatTokenCount } from "../engine/tokens.js";

interface DashboardViewProps {
  state: TuiState;
}

function miniProgressBar(done: number, total: number): string {
  if (total === 0) return "";
  const barWidth = 20;
  const filled = Math.round((done / total) * barWidth);
  return "\u2593".repeat(filled) + "\u2591".repeat(barWidth - filled);
}

function formatElapsedMm(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  return `${String(mins).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
}

const RESULT_ICONS: Record<string, string> = {
  done: "\u2713",
  failed: "\u2717",
  in_progress: "\u25B6",
  open: "\u25CB",
  skipped: "\u2014",
};

export function DashboardView({ state }: DashboardViewProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const tasks = state.tasks;
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const total = tasks.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const showTokens = width >= 100;
  const showTime = width >= 80;

  // Calculate total elapsed, total iterations, total tokens
  const elapsedMs = Date.now() - state.startTime;
  const totalIters = state.iteration;
  const sessionTokens = state.tokenUsage.hasData
    ? formatTokenCount(state.tokenUsage.sessionTotal.totalTokens)
    : "N/A";

  return (
    <box width={width} height={height} flexDirection="column">
      <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text>
          <span fg={colors.accent.primary} attributes={boldAttr()}>Dashboard</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.secondary}>{done}/{total} tasks</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.status.success}>{miniProgressBar(done, total)}</span>
          <span fg={colors.fg.primary} attributes={boldAttr()}> {pct}%</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.secondary}>iter {state.iteration}/{state.maxIterations}</span>
          {showTokens && (
            <>
              <span fg={colors.fg.muted}>{" │ "}</span>
              <span fg={colors.accent.secondary}>{sessionTokens} tokens</span>
            </>
          )}
        </text>
      </box>
      <text>{""}</text>
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.fg.muted} attributes={boldAttr()}>
            {"ID".padEnd(8)} {"Title".padEnd(40)} {"Status".padEnd(12)} {"Pri".padEnd(4)} {"Iters".padEnd(6)}{showTime ? " " + "Time".padEnd(7) : ""}{showTokens ? " " + "Tokens".padEnd(8) : ""} Result
          </span>
        </text>
      </box>
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.border.normal}>{"\u2500".repeat(Math.min(width - 2, showTokens ? 110 : showTime ? 95 : 85))}</span>
        </text>
      </box>
      <scrollbox flexGrow={1} stickyScroll={true} stickyStart="top" style={{ flexDirection: "column", paddingLeft: 1 }}>
        {tasks.map((task) => {
          const icon = statusIndicators[task.status] ?? "?";
          const statusColor = STATUS_COLORS_HEX[task.status] ?? colors.fg.muted;
          const priorityColor = PRIORITY_COLORS_HEX[task.priority] ?? colors.fg.muted;
          const resultIcon = RESULT_ICONS[task.status] ?? "?";
          const resultColor = task.status === "done" ? colors.status.success
            : task.status === "failed" ? colors.status.error
            : colors.fg.muted;
          const title =
            task.title.length > 40
              ? task.title.slice(0, 37) + "..."
              : task.title.padEnd(40);
          const taskTokens = state.tokenUsage.taskTotals[task.id];
          const tokenStr = taskTokens ? formatTokenCount(taskTokens.totalTokens) : "N/A";

          return (
            <text key={task.id}>
              <span fg={colors.fg.secondary}>{task.id.padEnd(8)}</span>
              {" "}
              <span fg={colors.fg.primary}>{title}</span>
              {" "}
              <span fg={statusColor}>{icon} {task.status.padEnd(10)}</span>
              {" "}
              <span fg={priorityColor}>P{task.priority}</span>
              {"  "}
              <span fg={colors.fg.muted}>{String(task.iterationCount).padEnd(6)}</span>
              {showTime && <span fg={colors.fg.muted}>{" "}{task.status === "done" || task.status === "failed" ? formatElapsedMm(0) : task.status === "in_progress" ? formatElapsedMm(elapsedMs) : "  --  "}</span>}
              {showTokens && <span fg={colors.fg.muted}>{"  "}{tokenStr.padEnd(8)}</span>}
              <span fg={resultColor}> {resultIcon}</span>
            </text>
          );
        })}
      </scrollbox>
      {/* Summary row */}
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.border.normal}>{"\u2500".repeat(Math.min(width - 2, showTokens ? 110 : showTime ? 95 : 85))}</span>
        </text>
      </box>
      <box height={1} style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.fg.primary} attributes={boldAttr()}>{"TOTAL".padEnd(8)}</span>
          {" "}
          <span fg={colors.fg.muted}>{`${done}/${total} tasks completed`.padEnd(40)}</span>
          {" "}
          <span fg={failed > 0 ? colors.status.error : colors.status.success}>{failed > 0 ? `${failed} failed` : "all good"}</span>
          {"      "}
          <span fg={colors.fg.muted}>{String(totalIters).padEnd(6)}</span>
          {showTime && <span fg={colors.fg.muted}>{" "}{formatElapsedMm(elapsedMs)}</span>}
          {showTokens && <span fg={colors.accent.secondary}>{"  "}{sessionTokens.padEnd(8)}</span>}
        </text>
      </box>
      <Footer view="dashboard" width={width} />
    </box>
  );
}
