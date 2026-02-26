import { useState, useEffect, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { TuiState, NavMode } from "./types.js";
import { layout } from "./theme.js";
import { Header } from "./components/Header.js";
import type { ParallelHeaderInfo, ParallelCompletionInfo } from "./components/Header.js";
import { TaskSidebar } from "./components/TaskSidebar.js";
import { OutputPane } from "./components/OutputPane.js";
import { StatusBar } from "./components/StatusBar.js";
import type { ParallelStatusInfo } from "./components/StatusBar.js";

interface ExecutionViewProps {
  state: TuiState;
  selectedTaskIndex: number;
  navMode: NavMode;
  detailFocus: "task" | "output";
  parallel?: ParallelHeaderInfo | null;
  parallelCompletion?: ParallelCompletionInfo | null;
  parallelStatus?: ParallelStatusInfo | null;
  exitArmed?: boolean;
}

export function ExecutionView({ state, selectedTaskIndex, navMode, detailFocus, parallel, parallelCompletion, parallelStatus, exitArmed }: ExecutionViewProps): ReactNode {
  const [, tick] = useState(0);
  useEffect(() => {
    if (state.engineState !== "executing" && state.engineState !== "reviewing") return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [state.engineState]);

  const { width, height } = useTerminalDimensions();
  const sidebarWidth = Math.max(
    layout.sidebar.minWidth,
    Math.min(layout.sidebar.maxWidth, Math.floor(width * layout.sidebar.defaultWidthPercent / 100)),
  );
  const contentWidth = width - sidebarWidth;
  const bodyHeight = height - layout.header.height - layout.footer.height - 1;
  const done = state.tasks.filter((t) => t.status === "done").length;

  // Clamp selectedTaskIndex to valid range
  const clampedIndex = Math.min(selectedTaskIndex, Math.max(0, state.tasks.length - 1));
  const selectedTask = state.tasks[clampedIndex] ?? null;

  // Determine if the selected task is the currently executing one
  const isSelectedTaskActive = selectedTask?.id === state.currentTaskId;

  // Show live output for active task, stored output for others
  const storedOutput = selectedTask ? (state.taskOutputMap[selectedTask.id] ?? "") : "";
  const isCompletedWithNoOutput = !isSelectedTaskActive
    && selectedTask
    && (selectedTask.status === "done" || selectedTask.status === "failed")
    && !storedOutput;
  const displayOutput = isSelectedTaskActive
    ? state.output
    : isCompletedWithNoOutput
      ? "No output recorded"
      : storedOutput;

  // Only show thinking indicator for the active task
  const showThinking = isSelectedTaskActive && state.isThinking;
  const showPhase = isSelectedTaskActive ? state.currentPhase : null;
  const showPhaseStartTime = isSelectedTaskActive ? state.phaseStartTime : null;
  const taskDetailFocused = navMode === "task-detail-scroll" || (navMode === "detail-select" && detailFocus === "task");
  const outputFocused = navMode === "output-scroll" || (navMode === "detail-select" && detailFocus === "output");

  return (
    <box width={width} height={height} flexDirection="column">
      <Header
        projectName={state.projectName}
        sessionId={state.sessionId}
        iteration={state.iteration}
        maxIterations={state.maxIterations}
        agentName={state.agentName}
        elapsedMs={Date.now() - state.startTime}
        done={done}
        total={state.tasks.length}
        width={width}
        sessionTokens={state.tokenUsage.hasData ? state.tokenUsage.sessionTotal.totalTokens : null}
        parallel={parallel}
        parallelCompletion={parallelCompletion}
      />
      <box flexDirection="row" height={bodyHeight}>
        <TaskSidebar
          tasks={state.tasks}
          currentTaskId={state.currentTaskId}
          selectedTaskIndex={clampedIndex}
          width={sidebarWidth}
          height={bodyHeight}
        />
        <OutputPane
          output={displayOutput}
          width={contentWidth}
          height={bodyHeight}
          isThinking={showThinking}
          currentPhase={showPhase}
          phaseStartTime={showPhaseStartTime}
          task={selectedTask}
          outputScrollFocused={navMode === "output-scroll"}
          outputFocused={outputFocused}
          taskDetailFocused={taskDetailFocused}
          taskDetailScrollFocused={navMode === "task-detail-scroll"}
          autoScroll={isSelectedTaskActive && navMode === "task-scroll"}
        />
      </box>
      <StatusBar
        state={state.engineState}
        iteration={state.iteration}
        agentName={state.agentName}
        elapsedMs={Date.now() - state.startTime}
        width={width}
        currentPhase={state.currentPhase}
        navMode={navMode}
        currentTaskTokens={
          state.currentTaskId && state.tokenUsage.taskTotals[state.currentTaskId]
            ? state.tokenUsage.taskTotals[state.currentTaskId].totalTokens
            : null
        }
        parallelStatus={parallelStatus}
        exitArmed={exitArmed}
      />
    </box>
  );
}
