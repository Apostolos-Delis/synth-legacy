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

  // Word-wrap description into lines that fit the available width.
  const innerWidth = Math.max(1, width - 6);
  const descLines: string[] = [];
  let remaining = task.description;
  while (remaining.length > 0) {
    if (remaining.length <= innerWidth) {
      descLines.push(remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf(" ", innerWidth);
    if (breakAt <= 0) breakAt = innerWidth;
    descLines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (descLines.length === 0) descLines.push("");

  // Build acceptance criteria rows, respecting height limit.
  // Reserve 2 for border, 1 for title, descLines for description, 1 blank separator.
  const maxCriteriaRows = Math.max(0, height - 2 - 1 - descLines.length - 1);
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
      {descLines.map((line, i) => (
        <text key={`desc-${i}`}>
          <span fg={colors.fg.muted}>{line}</span>
        </text>
      ))}
      <text />
      {criteriaRows}
    </box>
  );
}, (prev, next) =>
  prev.width === next.width &&
  prev.height === next.height &&
  prev.task === next.task,
);
