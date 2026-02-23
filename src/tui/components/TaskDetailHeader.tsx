import { memo, type ReactNode } from "react";
import type { Task } from "../../tasks/types.js";
import { boldAttr, statusIndicators, colors, STATUS_COLORS_HEX } from "../theme.js";

interface TaskDetailHeaderProps {
  task: Task;
  width: number;
  height?: number;
}

export const TaskDetailHeader = memo(function TaskDetailHeader({
  task,
  width,
  height = 10,
}: TaskDetailHeaderProps): ReactNode {
  const statusIcon = statusIndicators[task.status] ?? "?";
  const statusColor = STATUS_COLORS_HEX[task.status] ?? colors.fg.muted;

  // Build acceptance criteria rows, respecting height limit.
  // Reserve 2 for border, 1 for title, 1 for description, 1 blank separator.
  const maxCriteriaRows = Math.max(0, height - 2 - 3);
  const criteria = task.acceptanceCriteria;
  const completed = task.criteriaCompleted;

  const criteriaRows: ReactNode[] = [];
  const visibleCount = Math.min(criteria.length, maxCriteriaRows);
  for (let i = 0; i < visibleCount; i++) {
    const done = completed?.[i] ?? false;
    const icon = done ? "\u2713" : "\u25CB";
    const iconColor = done ? colors.status.success : colors.fg.muted;
    const maxLen = width - 12;
    const text = criteria[i].length > maxLen ? criteria[i].slice(0, maxLen - 3) + "..." : criteria[i];

    criteriaRows.push(
      <text key={`ac-${i}`}>
        <span fg={iconColor}> {icon}</span>
        <span fg={colors.fg.secondary}> #{i + 1} </span>
        <span fg={colors.fg.primary}>{text}</span>
      </text>,
    );
  }

  if (criteria.length > visibleCount) {
    criteriaRows.push(
      <text key="ac-more">
        <span fg={colors.fg.muted}>  +{criteria.length - visibleCount} more...</span>
      </text>,
    );
  }

  const descMaxLen = width - 6;
  const desc =
    task.description.length > descMaxLen
      ? task.description.slice(0, descMaxLen - 3) + "..."
      : task.description;

  return (
    <box
      width={width}
      height={height}
      border={true}
      borderColor={colors.border.active}
      flexDirection="column"
    >
      <text>
        <span fg={statusColor} attributes={boldAttr()}>{statusIcon} </span>
        <span fg={colors.fg.primary} attributes={boldAttr()}>{task.title}</span>
        <span fg={statusColor}> [{task.status}]</span>
      </text>
      <text>
        <span fg={colors.fg.muted}>{desc}</span>
      </text>
      <text />
      {criteriaRows}
    </box>
  );
}, (prev, next) =>
  prev.width === next.width &&
  prev.height === next.height &&
  prev.task === next.task,
);
