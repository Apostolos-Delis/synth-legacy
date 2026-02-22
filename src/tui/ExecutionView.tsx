import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { TuiState } from "./types.js";
import { layout } from "./theme.js";
import { Header } from "./components/Header.js";
import { TaskSidebar } from "./components/TaskSidebar.js";
import { OutputPane } from "./components/OutputPane.js";
import { StatusBar } from "./components/StatusBar.js";

interface ExecutionViewProps {
  state: TuiState;
}

export function ExecutionView({ state }: ExecutionViewProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const sidebarWidth = Math.max(
    layout.sidebar.minWidth,
    Math.min(layout.sidebar.maxWidth, Math.floor(width * layout.sidebar.defaultWidthPercent / 100)),
  );
  const contentWidth = width - sidebarWidth;
  const bodyHeight = height - layout.header.height - layout.footer.height - 1;
  const done = state.tasks.filter((t) => t.status === "done").length;

  return (
    <box width={width} height={height} flexDirection="column">
      <Header
        projectName={state.projectName}
        planId={state.planId}
        iteration={state.iteration}
        maxIterations={state.maxIterations}
        agentName={state.agentName}
        elapsedMs={Date.now() - state.startTime}
        done={done}
        total={state.tasks.length}
        width={width}
      />
      <box flexDirection="row" height={bodyHeight}>
        <TaskSidebar
          tasks={state.tasks}
          currentTaskId={state.currentTaskId}
          width={sidebarWidth}
          height={bodyHeight}
        />
        <OutputPane
          output={state.output}
          width={contentWidth}
          height={bodyHeight}
        />
      </box>
      <StatusBar
        state={state.engineState}
        iteration={state.iteration}
        agentName={state.agentName}
        elapsedMs={Date.now() - state.startTime}
        width={width}
      />
    </box>
  );
}
