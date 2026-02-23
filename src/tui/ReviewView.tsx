import { useState, useCallback, type ReactNode } from "react";
import { useTerminalDimensions, useKeyboard } from "@opentui/react";
import type { Task } from "../tasks/types.js";
import { boldAttr, colors, statusIndicators, STATUS_COLORS_HEX, PRIORITY_COLORS_HEX, layout, markdownSyntaxStyle } from "./theme.js";
import { Footer } from "./components/Footer.js";

interface ReviewViewProps {
  tasks: Task[];
  planId: string;
  onConfirm: () => void;
  onDecline: () => void;
}

const PRIORITY_LABELS: Record<number, string> = {
  1: "Critical",
  2: "High",
  3: "Medium",
  4: "Low",
  5: "Lowest",
};

function buildTaskIdMap(tasks: Task[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of tasks) map.set(t.id, t.title);
  return map;
}

export function ReviewView({ tasks, planId, onConfirm, onDecline }: ReviewViewProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const [selectedIndex, setSelectedIndex] = useState(0);

  useKeyboard(useCallback((key: { name: string }) => {
    if (key.name === "return") {
      onConfirm();
    } else if (key.name === "escape" || key.name === "q") {
      onDecline();
    } else if (key.name === "j" || key.name === "down") {
      setSelectedIndex((i) => Math.min(i + 1, tasks.length - 1));
    } else if (key.name === "k" || key.name === "up") {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }
  }, [onConfirm, onDecline, tasks.length]));

  const sidebarWidth = Math.max(
    layout.sidebar.minWidth,
    Math.min(layout.sidebar.maxWidth, Math.floor(width * layout.sidebar.defaultWidthPercent / 100)),
  );
  const detailWidth = width - sidebarWidth;
  const bodyHeight = height - layout.header.height - layout.footer.height;

  const taskIdMap = buildTaskIdMap(tasks);
  const selectedTask = tasks[selectedIndex] ?? null;

  // Summary stats
  const depCount = tasks.reduce((acc, t) => acc + (t.dependsOn?.length ?? 0), 0);

  return (
    <box width={width} height={height} flexDirection="column">
      {/* Header */}
      <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text>
          <span fg={colors.accent.primary} attributes={boldAttr()}>Task Review</span>
          <span fg={colors.fg.muted}>{" \u2502 "}</span>
          <span fg={colors.fg.secondary}>{tasks.length} tasks</span>
          <span fg={colors.fg.muted}>{" \u2502 "}</span>
          <span fg={colors.fg.secondary}>{depCount} dependencies</span>
          <span fg={colors.fg.muted}>{" \u2502 "}</span>
          <span fg={colors.fg.muted}>{planId}</span>
        </text>
      </box>

      {/* Body: task list + detail pane */}
      <box flexDirection="row" height={bodyHeight}>
        <TaskListPane
          tasks={tasks}
          selectedIndex={selectedIndex}
          width={sidebarWidth}
          height={bodyHeight}
        />
        {selectedTask && (
          <TaskDetailPane
            task={selectedTask}
            taskIdMap={taskIdMap}
            width={detailWidth}
            height={bodyHeight}
          />
        )}
      </box>

      <Footer view="review" width={width} />
    </box>
  );
}

// ─── Left pane: scrollable task list ───

interface TaskListPaneProps {
  tasks: Task[];
  selectedIndex: number;
  width: number;
  height: number;
}

function TaskListPane({ tasks, selectedIndex, width, height }: TaskListPaneProps): ReactNode {
  const innerHeight = height - 2; // border top+bottom
  const needsScroll = tasks.length > innerHeight;

  const taskRows = tasks.map((task, index) => {
    const icon = statusIndicators[task.status] ?? "?";
    const statusColor = STATUS_COLORS_HEX[task.status] ?? colors.fg.muted;
    const priorityColor = PRIORITY_COLORS_HEX[task.priority] ?? colors.fg.muted;
    const selected = index === selectedIndex;
    const titleMaxLen = width - 14;
    const title =
      task.title.length > titleMaxLen
        ? task.title.slice(0, titleMaxLen - 3) + "..."
        : task.title;

    const indicator = selected ? "\u25B8" : " ";
    const indicatorColor = selected ? colors.accent.secondary : colors.fg.dim;

    return (
      <text key={task.id}>
        <span fg={indicatorColor}>{indicator}</span>
        <span fg={statusColor}>{icon}</span>
        {" "}
        <span fg={priorityColor}>P{task.priority}</span>
        {" "}
        <span fg={selected ? colors.fg.primary : colors.fg.secondary} attributes={selected ? boldAttr() : undefined}>
          {task.id}
        </span>
        {" "}
        <span fg={selected ? colors.fg.primary : colors.fg.muted}>{title}</span>
      </text>
    );
  });

  return (
    <box
      width={width}
      height={height}
      border={true}
      borderColor={colors.border.normal}
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
}

// ─── Right pane: selected task detail ───

interface TaskDetailPaneProps {
  task: Task;
  taskIdMap: Map<string, string>;
  width: number;
  height: number;
}

function TaskDetailPane({ task, taskIdMap, width, height }: TaskDetailPaneProps): ReactNode {
  const priorityColor = PRIORITY_COLORS_HEX[task.priority] ?? colors.fg.muted;
  const priorityLabel = PRIORITY_LABELS[task.priority] ?? `P${task.priority}`;
  const innerWidth = Math.max(1, width - 4); // account for border + padding

  return (
    <box
      width={width}
      height={height}
      border={true}
      borderColor={colors.border.active}
      title={task.id}
      flexDirection="column"
    >
      <scrollbox
        flexGrow={1}
        stickyScroll={true}
        stickyStart="top"
        style={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}
      >
        {/* Title + Priority badge */}
        <text>
          <span fg={colors.fg.primary} attributes={boldAttr()}>{task.title}</span>
          {"  "}
          <span fg={priorityColor} attributes={boldAttr()}>[{priorityLabel}]</span>
        </text>

        <text>{""}</text>

        {/* Description rendered as markdown */}
        <box style={{ flexDirection: "column" }}>
          <text>
            <span fg={colors.accent.primary} attributes={boldAttr()}>{"\u2500"} Description</span>
          </text>
          <box style={{ paddingLeft: 1 }}>
            <markdown
              content={task.description}
              syntaxStyle={markdownSyntaxStyle()}
              width={innerWidth - 1}
            />
          </box>
        </box>

        <text>{""}</text>

        {/* Acceptance Criteria */}
        {task.acceptanceCriteria.length > 0 && (
          <box style={{ flexDirection: "column" }}>
            <text>
              <span fg={colors.accent.primary} attributes={boldAttr()}>{"\u2500"} Acceptance Criteria</span>
              <span fg={colors.fg.muted}> ({task.acceptanceCriteria.length})</span>
            </text>
            {task.acceptanceCriteria.map((criterion, i) => (
              <text key={`ac-${i}`}>
                <span fg={colors.fg.muted}>  {"  "}\u25CB </span>
                <span fg={colors.fg.secondary}>#{i + 1} </span>
                <span fg={colors.fg.primary}>{wordWrap(criterion, innerWidth - 8)}</span>
              </text>
            ))}
          </box>
        )}

        <text>{""}</text>

        {/* Dependencies */}
        <box style={{ flexDirection: "column" }}>
          <text>
            <span fg={colors.accent.primary} attributes={boldAttr()}>{"\u2500"} Dependencies</span>
          </text>
          {task.dependsOn && task.dependsOn.length > 0 ? (
            task.dependsOn.map((depId) => {
              const depTitle = taskIdMap.get(depId) ?? "Unknown";
              return (
                <text key={depId}>
                  <span fg={colors.fg.muted}>  {"  "}\u2192 </span>
                  <span fg={colors.accent.secondary}>{depId}</span>
                  <span fg={colors.fg.muted}> {depTitle}</span>
                </text>
              );
            })
          ) : (
            <text>
              <span fg={colors.fg.muted}>  {"  "}None</span>
            </text>
          )}
        </box>

        {/* Notes (if present) */}
        {task.notes && (
          <>
            <text>{""}</text>
            <box style={{ flexDirection: "column" }}>
              <text>
                <span fg={colors.accent.primary} attributes={boldAttr()}>{"\u2500"} Notes</span>
              </text>
              <box style={{ paddingLeft: 1 }}>
                <markdown
                  content={task.notes}
                  syntaxStyle={markdownSyntaxStyle()}
                  width={innerWidth - 1}
                />
              </box>
            </box>
          </>
        )}
      </scrollbox>
    </box>
  );
}

function wordWrap(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxWidth) {
      lines.push(remaining);
      break;
    }
    // Find last space within maxWidth
    let breakAt = remaining.lastIndexOf(" ", maxWidth);
    if (breakAt <= 0) breakAt = maxWidth;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  return lines.join("\n          "); // indent continuation lines
}
