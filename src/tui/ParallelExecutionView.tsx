import { useState, useEffect, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { TuiState, NavMode } from "./types.js";
import { layout } from "./theme.js";
import { Header } from "./components/Header.js";
import type { ParallelHeaderInfo, ParallelCompletionInfo } from "./components/Header.js";
import { OutputPane } from "./components/OutputPane.js";
import { StatusBar } from "./components/StatusBar.js";
import type { ParallelStatusInfo } from "./components/StatusBar.js";
import { WorkerPanel } from "./components/WorkerPanel.js";
import type { WorkerInfo } from "./components/WorkerPanel.js";
import { TaskSidebar } from "./components/TaskSidebar.js";
import { MergeQueuePanel } from "./components/MergeQueuePanel.js";
import type { MergeQueueItem } from "./components/MergeQueuePanel.js";
import { ConflictResolutionPanel } from "./components/ConflictResolutionPanel.js";
import type { ConflictInfo } from "./components/ConflictResolutionPanel.js";

interface ParallelExecutionViewProps {
  state: TuiState;
  selectedTaskIndex: number;
  navMode: NavMode;
  parallel?: ParallelHeaderInfo | null;
  parallelCompletion?: ParallelCompletionInfo | null;
  parallelStatus?: ParallelStatusInfo | null;
  workers: WorkerInfo[];
  mergeItems: MergeQueueItem[];
  conflict: ConflictInfo | null;
}

export function ParallelExecutionView({
  state,
  selectedTaskIndex,
  navMode,
  parallel,
  parallelCompletion,
  parallelStatus,
  workers,
  mergeItems,
  conflict,
}: ParallelExecutionViewProps): ReactNode {
  const [, tick] = useState(0);
  useEffect(() => {
    if (state.engineState !== "executing" && state.engineState !== "reviewing") return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [state.engineState]);

  const { width, height } = useTerminalDimensions();
  const bodyHeight = height - layout.header.height - layout.footer.height - 1;
  const done = state.tasks.filter((t) => t.status === "done").length;

  // Top row: workers panel (left) + output pane (right)
  const workerPanelWidth = Math.max(
    layout.sidebar.minWidth,
    Math.min(layout.sidebar.maxWidth, Math.floor(width * layout.sidebar.defaultWidthPercent / 100)),
  );
  const outputWidth = width - workerPanelWidth;

  // Bottom row for merge queue + conflict resolution
  const hasConflict = conflict !== null;
  const bottomHeight = Math.max(6, Math.min(12, Math.floor(bodyHeight * 0.3)));
  const topHeight = bodyHeight - bottomHeight;

  // Split left column: TaskSidebar on top, WorkerPanel below (hide sidebar when no tasks)
  const showTaskSidebar = state.tasks.length > 0;
  const taskSidebarHeight = showTaskSidebar ? Math.min(state.tasks.length + 2, Math.floor(topHeight / 2)) : 0;
  const workerPanelHeight = topHeight - taskSidebarHeight;

  // Bottom row widths: merge queue gets more space when no conflict
  const mergeWidth = hasConflict ? Math.floor(width * 0.55) : width;
  const conflictWidth = hasConflict ? width - mergeWidth : 0;

  // Determine selected task for output pane
  const clampedIndex = Math.min(selectedTaskIndex, Math.max(0, state.tasks.length - 1));
  const selectedTask = state.tasks[clampedIndex] ?? null;
  const isSelectedTaskActive = selectedTask?.id === state.currentTaskId;

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

  const showThinking = isSelectedTaskActive && state.isThinking;
  const showPhase = isSelectedTaskActive ? state.currentPhase : null;
  const showPhaseStartTime = isSelectedTaskActive ? state.phaseStartTime : null;

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
      <box flexDirection="column" height={bodyHeight}>
        <box flexDirection="row" height={topHeight}>
          <box flexDirection="column" width={workerPanelWidth} height={topHeight}>
            {showTaskSidebar && (
              <TaskSidebar
                tasks={state.tasks}
                currentTaskId={state.currentTaskId}
                selectedTaskIndex={clampedIndex}
                width={workerPanelWidth}
                height={taskSidebarHeight}
              />
            )}
            <WorkerPanel
              workers={workers}
              width={workerPanelWidth}
              height={workerPanelHeight}
            />
          </box>
          <OutputPane
            output={displayOutput}
            width={outputWidth}
            height={topHeight}
            isThinking={showThinking}
            currentPhase={showPhase}
            phaseStartTime={showPhaseStartTime}
            task={selectedTask}
            outputScrollFocused={navMode === "output-scroll"}
            autoScroll={isSelectedTaskActive && navMode !== "output-scroll"}
          />
        </box>
        <box flexDirection="row" height={bottomHeight}>
          <MergeQueuePanel
            items={mergeItems}
            width={mergeWidth}
            height={bottomHeight}
          />
          {hasConflict && (
            <ConflictResolutionPanel
              conflict={conflict}
              width={conflictWidth}
              height={bottomHeight}
            />
          )}
        </box>
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
      />
    </box>
  );
}
