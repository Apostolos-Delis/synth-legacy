import { memo, type ReactNode } from "react";
import type { Task } from "../../tasks/types.js";
import { boldAttr, statusIndicators, colors, STATUS_COLORS_HEX, PRIORITY_COLORS_HEX } from "../theme.js";

interface TaskSidebarProps {
  tasks: Task[];
  currentTaskId: string | null;
  selectedTaskIndex: number;
  width: number;
  height: number;
}

export const TaskSidebar = memo(function TaskSidebar({
  tasks,
  currentTaskId,
  selectedTaskIndex,
  width,
  height,
}: TaskSidebarProps): ReactNode {
  const isCurrent = (id: string) => id === currentTaskId;
  const borderFg = currentTaskId ? colors.border.active : colors.border.normal;

  // 2 rows for top+bottom border
  const innerHeight = height - 2;
  const needsScroll = tasks.length > innerHeight;

  const taskRows = tasks.map((task, index) => {
    const icon = statusIndicators[task.status] ?? "?";
    const statusColor = STATUS_COLORS_HEX[task.status] ?? colors.fg.muted;
    const priorityColor = PRIORITY_COLORS_HEX[task.priority] ?? colors.fg.muted;
    const active = isCurrent(task.id);
    const selected = index === selectedTaskIndex;
    const highlighted = active || selected;
    const titleMaxLen = width - 14;
    const title =
      task.title.length > titleMaxLen
        ? task.title.slice(0, titleMaxLen - 3) + "..."
        : task.title;

    // Selected indicator: ▸ for selected, › for executing (not selected), space otherwise
    const indicator = selected ? "\u25B8" : active ? "\u203A" : " ";
    const indicatorColor = selected ? colors.accent.secondary : active ? colors.accent.primary : colors.fg.dim;

    return (
      <text key={task.id}>
        <span fg={indicatorColor}>{indicator}</span>
        <span fg={statusColor}>{icon}</span>
        {" "}
        <span fg={priorityColor}>P{task.priority}</span>
        {" "}
        <span fg={highlighted ? colors.fg.primary : colors.fg.secondary} attributes={highlighted ? boldAttr() : undefined}>
          {task.id}
        </span>
        {" "}
        <span fg={highlighted ? colors.fg.primary : colors.fg.muted}>{title}</span>
      </text>
    );
  });

  return (
    <box
      width={width}
      height={height}
      border={true}
      borderColor={borderFg}
      title="Tasks"
      flexDirection="column"
    >
      {needsScroll ? (
        <scrollbox
          flexGrow={1}
          stickyScroll={true}
          stickyStart="top"
          style={{ flexDirection: "column" }}
        >
          {taskRows}
        </scrollbox>
      ) : (
        <box flexGrow={1} style={{ flexDirection: "column" }}>
          {taskRows}
        </box>
      )}
    </box>
  );
}, (prev, next) => {
  if (prev.width !== next.width || prev.height !== next.height || prev.currentTaskId !== next.currentTaskId || prev.selectedTaskIndex !== next.selectedTaskIndex) return false;
  if (prev.tasks === next.tasks) return true;
  if (prev.tasks.length !== next.tasks.length) return false;
  return prev.tasks.every((t, i) =>
    t.id === next.tasks[i].id &&
    t.status === next.tasks[i].status &&
    t.priority === next.tasks[i].priority,
  );
});
