import { memo, useMemo, type ReactNode } from "react";
import type { Task } from "../../tasks/types.js";
import { boldAttr, statusIndicators, colors, STATUS_COLORS_HEX, PRIORITY_COLORS_HEX } from "../theme.js";
import { startSpan, endSpan } from "../profiler.js";

const FLEX_COL_STYLE = { flexDirection: "column" } as const;

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
  const renderSpan = startSpan("TaskSidebar");
  const isCurrent = (id: string) => id === currentTaskId;
  const borderFg = currentTaskId ? colors.border.active : colors.border.normal;

  const innerWidth = Math.max(1, width - 2);
  const padLine = (text: string): string => {
    if (text.length >= innerWidth) return text.slice(0, innerWidth);
    return text + " ".repeat(innerWidth - text.length);
  };

  // 2 rows for top+bottom border
  const innerHeight = height - 2;
  const contentHeight = Math.max(1, innerHeight);
  const visibleCount = Math.max(1, innerHeight);
  const maxStart = Math.max(0, tasks.length - visibleCount);
  const windowStart = useMemo(() => {
    if (tasks.length <= visibleCount) return 0;
    const preferred = selectedTaskIndex - Math.floor(visibleCount / 2);
    return Math.max(0, Math.min(preferred, maxStart));
  }, [tasks.length, selectedTaskIndex, visibleCount, maxStart]);
  const visibleTasks = tasks.slice(windowStart, windowStart + visibleCount);

  const taskRows = visibleTasks.map((task, i) => {
    const index = windowStart + i;
    const icon = statusIndicators[task.status] ?? "?";
    const statusColor = STATUS_COLORS_HEX[task.status] ?? colors.fg.muted;
    const priorityColor = PRIORITY_COLORS_HEX[task.priority] ?? colors.fg.muted;
    const active = isCurrent(task.id);
    const selected = index === selectedTaskIndex;
    const inProgress = task.status === "in_progress";
    const highlighted = active || selected || inProgress;
    const indicator = selected ? "\u25B8" : active ? "\u203A" : inProgress ? "\u2022" : " ";
    const indicatorColor = selected
      ? colors.accent.secondary
      : active
        ? colors.accent.primary
        : inProgress
          ? colors.status.info
          : colors.fg.dim;
    const prefix = `${indicator}${icon} P${task.priority} ${task.id} `;
    const titleMaxLen = Math.max(0, innerWidth - prefix.length);
    const title =
      task.title.length > titleMaxLen
        ? titleMaxLen <= 3
          ? task.title.slice(0, titleMaxLen)
          : task.title.slice(0, titleMaxLen - 3) + "..."
        : task.title;
    const rowText = `${prefix}${title}`;
    const rowPad = padLine(rowText).slice(rowText.length);

    return (
      <text key={task.id} truncate={true}>
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
        <span>{rowPad}</span>
      </text>
    );
  });

  endSpan("TaskSidebar", renderSpan);
  return (
    <box
      width={width}
      height={height}
      border={true}
      borderColor={borderFg}
      title="Tasks"
      flexDirection="column"
      overflow="hidden"
    >
      <box height={contentHeight} style={FLEX_COL_STYLE}>
        {taskRows}
        {Array.from({ length: Math.max(0, innerHeight - taskRows.length) }).map((_, i) => (
          <text key={`empty-${i}`}>
            <span>{padLine("")}</span>
          </text>
        ))}
      </box>
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
