import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { TuiState } from "./types.js";
import { STATUS_ICONS, STATUS_COLORS, PRIORITY_COLORS, colors } from "./theme.js";
import { Footer } from "./components/Footer.js";

interface DashboardViewProps {
  state: TuiState;
}

export function DashboardView({ state }: DashboardViewProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const tasks = state.tasks;
  const done = tasks.filter((t) => t.status === "done").length;
  const total = tasks.length;

  return (
    <box width={width} height={height} flexDirection="column">
      <text>
        {`${colors.bold} Dashboard${colors.reset} ${colors.muted}│${colors.reset} ${done}/${total} tasks complete ${colors.muted}│${colors.reset} iteration ${state.iteration}/${state.maxIterations}`}
      </text>
      <text>{""}</text>
      <text>
        {`${colors.bold} ${"ID".padEnd(8)} ${"Title".padEnd(40)} ${"Status".padEnd(12)} ${"Pri".padEnd(4)} Iters${colors.reset}`}
      </text>
      <text>{colors.muted}{"-".repeat(Math.min(width - 2, 80))}{colors.reset}</text>
      {tasks.map((task) => {
        const icon = STATUS_ICONS[task.status] ?? "?";
        const statusColor = STATUS_COLORS[task.status] ?? colors.muted;
        const priorityColor = PRIORITY_COLORS[task.priority] ?? colors.muted;
        const title =
          task.title.length > 40
            ? task.title.slice(0, 37) + "..."
            : task.title.padEnd(40);

        return (
          <text key={task.id}>
            {` ${task.id.padEnd(8)} ${title} ${statusColor}${icon} ${task.status.padEnd(10)}${colors.reset} ${priorityColor}P${task.priority}${colors.reset}   ${task.iterationCount}`}
          </text>
        );
      })}
      <box flexGrow={1} />
      <Footer view="dashboard" width={width} />
    </box>
  );
}
