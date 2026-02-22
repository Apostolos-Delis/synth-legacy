import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { TuiState } from "./types.js";
import { Header } from "./components/Header.js";
import { TaskSidebar } from "./components/TaskSidebar.js";
import { OutputPane } from "./components/OutputPane.js";
import { StatusBar } from "./components/StatusBar.js";

interface ExecutionViewProps {
  state: TuiState;
}

export function ExecutionView({ state }: ExecutionViewProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const sidebarWidth = Math.min(40, Math.floor(width * 0.3));
  const contentWidth = width - sidebarWidth;
  const bodyHeight = height - 3; // header + status bar + footer line

  return (
    <box width={width} height={height} flexDirection="column">
      <Header
        projectName={state.planId}
        planId={state.planId}
        iteration={state.iteration}
        maxIterations={state.maxIterations}
        agentName={state.agentName}
        elapsedMs={Date.now() - state.startTime}
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
