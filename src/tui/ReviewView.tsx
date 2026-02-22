import { useCallback, type ReactNode } from "react";
import { useTerminalDimensions, useKeyboard } from "@opentui/react";
import { createTextAttributes } from "@opentui/core";
import type { Task } from "../tasks/types.js";
import { colors, statusIndicators, STATUS_COLORS_HEX, PRIORITY_COLORS_HEX } from "./theme.js";
import { Footer } from "./components/Footer.js";

const boldAttr = createTextAttributes({ bold: true });

interface ReviewViewProps {
  tasks: Task[];
  planId: string;
  onConfirm: () => void;
  onDecline: () => void;
}

export function ReviewView({ tasks, planId, onConfirm, onDecline }: ReviewViewProps): ReactNode {
  const { width, height } = useTerminalDimensions();

  useKeyboard(useCallback((key: { name: string }) => {
    if (key.name === "return") {
      onConfirm();
    } else if (key.name === "escape" || key.name === "q") {
      onDecline();
    }
  }, [onConfirm, onDecline]));

  return (
    <box width={width} height={height} flexDirection="column">
      <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text>
          <span fg={colors.accent.primary} attributes={boldAttr}>Task Review</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.secondary}>{tasks.length} tasks</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.muted}>{planId}</span>
        </text>
      </box>

      <text>{""}</text>
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.fg.muted} attributes={boldAttr}>
            {"ID".padEnd(8)} {"Title".padEnd(40)} {"Pri".padEnd(4)} Deps
          </span>
        </text>
      </box>
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.border.normal}>{"\u2500".repeat(Math.min(width - 2, 70))}</span>
        </text>
      </box>

      <scrollbox stickyScroll={true} stickyStart="top" style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 1 }}>
        {tasks.map((task) => {
          const icon = statusIndicators[task.status] ?? "?";
          const statusColor = STATUS_COLORS_HEX[task.status] ?? colors.fg.muted;
          const priorityColor = PRIORITY_COLORS_HEX[task.priority] ?? colors.fg.muted;
          const title =
            task.title.length > 40
              ? task.title.slice(0, 37) + "..."
              : task.title.padEnd(40);
          const deps = task.dependsOn?.length ? task.dependsOn.join(", ") : "\u2014";

          return (
            <text key={task.id}>
              <span fg={statusColor}>{icon} </span>
              <span fg={colors.fg.secondary}>{task.id.padEnd(8)}</span>
              {" "}
              <span fg={colors.fg.primary}>{title}</span>
              {" "}
              <span fg={priorityColor}>P{task.priority}</span>
              {"   "}
              <span fg={colors.fg.muted}>{deps}</span>
            </text>
          );
        })}
      </scrollbox>

      <Footer view="review" width={width} />
    </box>
  );
}
