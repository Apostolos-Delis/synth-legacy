import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { TuiState } from "./types.js";
import { boldAttr, colors, statusIndicators, STATUS_COLORS_HEX, PRIORITY_COLORS_HEX } from "./theme.js";
import { Footer } from "./components/Footer.js";

interface DashboardViewProps {
  state: TuiState;
}

function miniProgressBar(done: number, total: number): string {
  if (total === 0) return "";
  const barWidth = 20;
  const filled = Math.round((done / total) * barWidth);
  return "\u2593".repeat(filled) + "\u2591".repeat(barWidth - filled);
}

export function DashboardView({ state }: DashboardViewProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const tasks = state.tasks;
  const done = tasks.filter((t) => t.status === "done").length;
  const total = tasks.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

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
        </text>
      </box>
      <text>{""}</text>
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.fg.muted} attributes={boldAttr()}>
            {"ID".padEnd(8)} {"Title".padEnd(40)} {"Status".padEnd(12)} {"Pri".padEnd(4)} Iters
          </span>
        </text>
      </box>
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.border.normal}>{"\u2500".repeat(Math.min(width - 2, 80))}</span>
        </text>
      </box>
      <scrollbox flexGrow={1} stickyScroll={true} stickyStart="top" style={{ flexDirection: "column", paddingLeft: 1 }}>
        {tasks.map((task) => {
          const icon = statusIndicators[task.status] ?? "?";
          const statusColor = STATUS_COLORS_HEX[task.status] ?? colors.fg.muted;
          const priorityColor = PRIORITY_COLORS_HEX[task.priority] ?? colors.fg.muted;
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
              <span fg={statusColor}>{icon} {task.status.padEnd(10)}</span>
              {" "}
              <span fg={priorityColor}>P{task.priority}</span>
              {"   "}
              <span fg={colors.fg.muted}>{task.iterationCount}</span>
            </text>
          );
        })}
      </scrollbox>
      <Footer view="dashboard" width={width} />
    </box>
  );
}
