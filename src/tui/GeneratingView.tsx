import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { boldAttr, colors } from "./theme.js";
import { Spinner } from "./components/Spinner.js";
import { PhaseIndicator } from "./components/PhaseIndicator.js";
import { Footer } from "./components/Footer.js";
import { startSpan, endSpan } from "./profiler.js";

interface GeneratingViewProps {
  output: string;
  taskCount?: number;
  phase?: string;
  phaseStartTime?: number;
  label?: string;
}

export function GeneratingView({ output, taskCount, phase, phaseStartTime, label }: GeneratingViewProps): ReactNode {
  const renderSpan = startSpan("GeneratingView");
  const { width, height } = useTerminalDimensions();
  const bodyHeight = Math.max(1, height - 2);
  const scrollHeight = Math.max(1, bodyHeight - 3);
  const spinnerLabel = label ?? "Agent is generating tasks";

  endSpan("GeneratingView", renderSpan);
  return (
    <box width={width} height={height} flexDirection="column">
      <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text>
          <span fg={colors.accent.primary} attributes={boldAttr()}>synth session</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.status.info}>{phase ?? "Generating tasks..."}</span>
        </text>
      </box>

      <box style={{ height: bodyHeight, flexDirection: "column", paddingLeft: 1, paddingTop: 1 }}>
        <box style={{ flexDirection: "row", gap: 1, marginBottom: 1 }}>
          {phaseStartTime
            ? <PhaseIndicator phase={spinnerLabel} startTime={phaseStartTime} />
            : <Spinner label={spinnerLabel} color={colors.status.info} />}
          {taskCount != null && taskCount > 0 && (
            <text fg={colors.status.success}>{`Found ${taskCount} task${taskCount === 1 ? "" : "s"} so far...`}</text>
          )}
        </box>
        <scrollbox height={scrollHeight} stickyScroll={true} stickyStart="bottom">
          <text fg={colors.fg.muted}>{output || "Waiting for agent output..."}</text>
        </scrollbox>
      </box>

      <Footer view="generating" width={width} />
    </box>
  );
}
