import { memo, useMemo, type ReactNode } from "react";
import type { Task } from "../../tasks/types.js";
import { boldAttr, statusIndicators, colors, STATUS_COLORS_HEX } from "../theme.js";
import { wrapText } from "../utils.js";
import { startSpan, endSpan } from "../profiler.js";

function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, maxWidth);
  return text.slice(0, maxWidth - 1) + "\u2026";
}

const FLEX_COL = { flexDirection: "column" } as const;

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
  focused?: boolean;
  scrollFocused?: boolean;
}

export const TaskDetailHeader = memo(function TaskDetailHeader({
  task,
  width,
  height = 10,
  focused = true,
  scrollFocused: _scrollFocused = false,
}: TaskDetailHeaderProps): ReactNode {
  const renderSpan = startSpan("TaskDetailHeader");
  const statusIcon = statusIndicators[task.status] ?? "?";
  const statusColor = STATUS_COLORS_HEX[task.status] ?? colors.fg.muted;
  const priorityLabel = PRIORITY_LABELS[task.priority] ?? `P${task.priority}`;

  const innerWidth = Math.max(1, width - 6);
  const innerHeight = Math.max(1, height - 2);
  const scrollHeight = Math.max(1, innerHeight - 1);
  const descLines = useMemo(() => wrapText(task.description, innerWidth), [task.description, innerWidth]);

  // Pre-truncate title to fit within the box alongside fixed-width elements
  const titlePrefix = `${statusIcon} [${task.id}] `;
  const titleSuffix = `  [${priorityLabel}] [${task.status}]`;
  const titleMaxLen = Math.max(10, innerWidth - titlePrefix.length - titleSuffix.length);
  const displayTitle = truncateText(task.title, titleMaxLen);
  const titleLineText = `${titlePrefix}${displayTitle}${titleSuffix}`;
  const titlePad = padLine("", Math.max(0, innerWidth - titleLineText.length));

  const criteria = task.acceptanceCriteria;
  const completed = task.criteriaCompleted;
  const dependencies = task.dependsOn?.filter(Boolean) ?? [];

  const criteriaRows: ReactNode[] = [];
  for (let i = 0; i < criteria.length; i++) {
    const done = completed?.[i] ?? false;
    const icon = done ? "\u2713" : "\u25CB";
    const iconColor = done ? colors.status.success : colors.fg.muted;
    const maxLen = Math.max(0, innerWidth - 8);
    const text = criteria[i].length > maxLen ? criteria[i].slice(0, Math.max(0, maxLen - 3)) + "..." : criteria[i];
    const rowText = ` ${icon} #${i + 1} ${text}`;
    const rowPad = padLine("", Math.max(0, innerWidth - rowText.length));

    criteriaRows.push(
      <text key={`ac-${i}`}>
        <span fg={iconColor}>{` ${icon} #${i + 1} ${text}${rowPad}`}</span>
      </text>,
    );
  }

  const contentRows: ReactNode[] = [];
  contentRows.push(
    <text key="desc-gap-top">
      <span>{padLine("", innerWidth)}</span>
    </text>,
  );
  for (let i = 0; i < descLines.length; i++) {
    const line = truncateText(descLines[i], innerWidth);
    const pad = padLine("", Math.max(0, innerWidth - line.length));
    contentRows.push(
      <text key={`desc-${i}`} fg={colors.fg.secondary}>{`${line}${pad}`}</text>,
    );
  }
  contentRows.push(
    <text key="desc-gap-bottom">
      <span>{padLine("", innerWidth)}</span>
    </text>,
  );
  if (dependencies.length > 0) {
    const depPrefix = "Depends on: ";
    const depWidth = Math.max(1, innerWidth - depPrefix.length);
    const depLines = wrapText(dependencies.join(", "), depWidth);
    for (let i = 0; i < depLines.length; i++) {
      const prefix = i === 0 ? depPrefix : " ".repeat(depPrefix.length);
      const lineText = `${prefix}${depLines[i]}`;
      const pad = padLine("", Math.max(0, innerWidth - lineText.length));
      contentRows.push(
        <text key={`dep-${i}`}>
          <span fg={colors.fg.secondary}>{prefix}</span>
          <span fg={colors.fg.primary}>{depLines[i]}</span>
          <span>{pad}</span>
        </text>,
      );
    }
  }
  if (criteria.length > 0) {
    contentRows.push(
      <text key="ac-header">
        <span fg={colors.accent.primary} attributes={boldAttr()}>{"\u2500"} Acceptance Criteria</span>
        <span fg={colors.fg.muted}> ({criteria.length})</span>
        <span>{padLine("", Math.max(0, innerWidth - `\u2500 Acceptance Criteria (${criteria.length})`.length))}</span>
      </text>,
    );
    contentRows.push(...criteriaRows);
  }

  endSpan("TaskDetailHeader", renderSpan);
  return (
    <box
      width={width}
      height={height}
      border={true}
      borderColor={focused ? colors.border.active : colors.border.normal}
      flexDirection="column"
      overflow="hidden"
    >
      <text>
        <span fg={statusColor} attributes={boldAttr()}>{`${statusIcon} [${task.id}] ${displayTitle}  [${priorityLabel}] [${task.status}]${titlePad}`}</span>
      </text>
      <box
        height={scrollHeight}
        style={FLEX_COL}
        overflow="hidden"
      >
        {contentRows}
      </box>
    </box>
  );
}, (prev, next) =>
  prev.width === next.width &&
  prev.height === next.height &&
  prev.task === next.task &&
  prev.focused === next.focused &&
  prev.scrollFocused === next.scrollFocused,
);
