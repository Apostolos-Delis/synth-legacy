import type { ReactNode } from "react";
import type { Task } from "../../tasks/types.js";
import { boldAttr, statusIndicators, colors, STATUS_COLORS_HEX, PRIORITY_COLORS_HEX } from "../theme.js";

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
  const isCurrent = (id: string) => id === currentTaskId;
  const borderFg = currentTaskId ? colors.border.active : colors.border.normal;

  return (
    <box
      width={width}
      height={height}
      border={true}
      borderColor={borderFg}
      title="Tasks"
      flexDirection="column"
    >
      <scrollbox
        flexGrow={1}
        stickyScroll={true}
        stickyStart="top"
        style={{ flexDirection: "column" }}
      >
        {tasks.map((task) => {
          const icon = statusIndicators[task.status] ?? "?";
          const statusColor = STATUS_COLORS_HEX[task.status] ?? colors.fg.muted;
          const priorityColor = PRIORITY_COLORS_HEX[task.priority] ?? colors.fg.muted;
          const active = isCurrent(task.id);
          const titleMaxLen = width - 14;
          const title =
            task.title.length > titleMaxLen
              ? task.title.slice(0, titleMaxLen - 3) + "..."
              : task.title;

          return (
            <text key={task.id}>
              <span fg={active ? colors.accent.primary : colors.fg.dim}>{active ? "\u25B8" : " "}</span>
              <span fg={statusColor}>{icon}</span>
              {" "}
              <span fg={priorityColor}>P{task.priority}</span>
              {" "}
              <span fg={active ? colors.fg.primary : colors.fg.secondary} attributes={active ? boldAttr() : undefined}>
                {task.id}
              </span>
              {" "}
              <span fg={active ? colors.fg.primary : colors.fg.muted}>{title}</span>
            </text>
          );
        })}
      </scrollbox>
    </box>
  );
}
