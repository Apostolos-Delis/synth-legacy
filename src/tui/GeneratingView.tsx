import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { boldAttr, colors } from "./theme.js";
import { Spinner } from "./components/Spinner.js";
import { Footer } from "./components/Footer.js";

interface GeneratingViewProps {
  output: string;
  taskCount?: number;
}

export function GeneratingView({ output, taskCount }: GeneratingViewProps): ReactNode {
  const { width, height } = useTerminalDimensions();

  return (
    <box width={width} height={height} flexDirection="column">
      <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text>
          <span fg={colors.accent.primary} attributes={boldAttr()}>synth plan</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.status.info}>Generating tasks...</span>
        </text>
      </box>

      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 1, paddingTop: 1 }}>
        <box style={{ flexDirection: "row", gap: 1, marginBottom: 1 }}>
          <Spinner label="Agent is generating tasks" color={colors.status.info} />
          {taskCount != null && taskCount > 0 && (
            <text fg={colors.status.success}>{`Found ${taskCount} task${taskCount === 1 ? "" : "s"} so far...`}</text>
          )}
        </box>
        <scrollbox style={{ flexGrow: 1 }} stickyScroll={true} stickyStart="bottom">
          <text fg={colors.fg.muted}>{output || "Waiting for agent output..."}</text>
        </scrollbox>
      </box>

      <Footer view="generating" width={width} />
    </box>
  );
}
