import type { ReactNode } from "react";
import type { Task } from "../../tasks/types.js";
import { STATUS_ICONS, STATUS_COLORS, PRIORITY_COLORS, colors } from "../theme.js";

interface TaskSidebarProps {
  tasks: Task[];
  currentTaskId: string | null;
  width: number;
  height: number;
}

export function TaskSidebar({
  tasks,
  currentTaskId,
  width,
  height,
}: TaskSidebarProps): ReactNode {
  const maxVisible = height - 2;
  const visibleTasks = tasks.slice(0, maxVisible);

  return (
    <box width={width} height={height} flexDirection="column">
      <text>{colors.bold} Tasks{colors.reset}</text>
      {visibleTasks.map((task) => {
        const icon = STATUS_ICONS[task.status] ?? "?";
        const statusColor = STATUS_COLORS[task.status] ?? colors.muted;
        const priorityColor = PRIORITY_COLORS[task.priority] ?? colors.muted;
        const isCurrent = task.id === currentTaskId;
        const marker = isCurrent ? ">" : " ";
        const title =
          task.title.length > width - 12
            ? task.title.slice(0, width - 15) + "..."
            : task.title;

        return (
          <text key={task.id}>
            {`${marker}${statusColor}${icon}${colors.reset} ${priorityColor}P${task.priority}${colors.reset} ${isCurrent ? colors.bold : ""}${task.id} ${title}${isCurrent ? colors.reset : ""}`}
          </text>
        );
      })}
      {tasks.length > maxVisible && (
        <text>{colors.muted} +{tasks.length - maxVisible} more{colors.reset}</text>
      )}
    </box>
  );
}
