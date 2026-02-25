import { memo, type ReactNode } from "react";
import type { Task } from "../../tasks/types.js";
import { boldAttr, statusIndicators, colors, STATUS_COLORS_HEX, PRIORITY_COLORS_HEX } from "../theme.js";
import { wrapText } from "../utils.js";

function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, maxWidth);
  return text.slice(0, maxWidth - 1) + "\u2026";
}

function padLine(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

const PRIORITY_LABELS: Record<number, string> = {
  1: "Critical",
  2: "High",
  3: "Medium",
  4: "Low",
  5: "Lowest",
};

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
  const priorityColor = PRIORITY_COLORS_HEX[task.priority] ?? colors.fg.muted;
  const priorityLabel = PRIORITY_LABELS[task.priority] ?? `P${task.priority}`;

  const innerWidth = Math.max(1, width - 6);
  const descLines = wrapText(task.description, innerWidth);

  // Pre-truncate title to fit within the box alongside fixed-width elements
  const titleOverhead = 2 + 1 + task.id.length + 1 + 2 + priorityLabel.length + 2 + 2 + task.status.length + 1;
  const titleMaxLen = Math.max(10, innerWidth - titleOverhead);
  const displayTitle = truncateText(task.title, titleMaxLen);
  const titleLineText = `${statusIcon} ${task.id} ${displayTitle}  [${priorityLabel}] [${task.status}]`;
  const titlePad = padLine("", Math.max(0, innerWidth - titleLineText.length));

  // Cap visible description lines to available space: border(2) + title(1) + blank sep(1)
  const maxDescLines = Math.max(1, height - 2 - 1 - 1);
  const visibleDescLines = descLines.slice(0, maxDescLines).map(
    (line) => padLine(truncateText(line, innerWidth), innerWidth),
  );

  // Build acceptance criteria rows, respecting height limit.
  // Reserve 2 for border, 1 for title, visibleDescLines for description, 1 blank separator,
  // and 1 for the section header line when criteria exist.
  const criteria = task.acceptanceCriteria;
  const sectionHeaderCost = criteria.length > 0 ? 1 : 0;
  const maxCriteriaRows = Math.max(0, height - 2 - 1 - visibleDescLines.length - 1 - sectionHeaderCost);
  const completed = task.criteriaCompleted;

  const criteriaRows: ReactNode[] = [];
  const visibleCount = Math.min(criteria.length, maxCriteriaRows);
  for (let i = 0; i < visibleCount; i++) {
    const done = completed?.[i] ?? false;
    const icon = done ? "\u2713" : "\u25CB";
    const iconColor = done ? colors.status.success : colors.fg.muted;
    const maxLen = Math.max(0, innerWidth - 8);
    const text = criteria[i].length > maxLen ? criteria[i].slice(0, Math.max(0, maxLen - 3)) + "..." : criteria[i];
    const rowText = ` ${icon} #${i + 1} ${text}`;
    const rowPad = padLine("", Math.max(0, innerWidth - rowText.length));

    criteriaRows.push(
      <text key={`ac-${i}`}>
        <span fg={iconColor}> {icon}</span>
        <span fg={colors.fg.secondary}> #{i + 1} </span>
        <span fg={colors.fg.primary}>{text}</span>
        <span>{rowPad}</span>
      </text>,
    );
  }

  if (criteria.length > visibleCount) {
    const moreText = `  +${criteria.length - visibleCount} more...`;
    const morePad = padLine("", Math.max(0, innerWidth - moreText.length));
    criteriaRows.push(
      <text key="ac-more">
        <span fg={colors.fg.muted}>{moreText}</span>
        <span>{morePad}</span>
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
      overflow="hidden"
    >
      <text>
        <span fg={statusColor} attributes={boldAttr()}>{statusIcon} </span>
        <span fg={colors.fg.secondary} attributes={boldAttr()}>{task.id}</span>
        {" "}
        <span fg={colors.fg.primary} attributes={boldAttr()}>{displayTitle}</span>
        {"  "}
        <span fg={priorityColor} attributes={boldAttr()}>[{priorityLabel}]</span>
        <span fg={statusColor}> [{task.status}]</span>
        <span>{titlePad}</span>
      </text>
      {visibleDescLines.map((line, i) => (
        <text key={`desc-${i}`}>
          <span fg={colors.fg.muted}>{line}</span>
        </text>
      ))}
      <text>
        <span>{padLine("", innerWidth)}</span>
      </text>
      {criteria.length > 0 && visibleCount > 0 && (
        <text>
          <span fg={colors.accent.primary} attributes={boldAttr()}>{"\u2500"} Acceptance Criteria</span>
          <span fg={colors.fg.muted}> ({criteria.length})</span>
          <span>{padLine("", Math.max(0, innerWidth - `\u2500 Acceptance Criteria (${criteria.length})`.length))}</span>
        </text>
      )}
      {criteriaRows}
    </box>
  );
}, (prev, next) =>
  prev.width === next.width &&
  prev.height === next.height &&
  prev.task === next.task,
);
