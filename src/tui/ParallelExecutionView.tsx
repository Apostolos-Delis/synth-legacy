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
  detailFocus: "task" | "output";
  parallel?: ParallelHeaderInfo | null;
  parallelCompletion?: ParallelCompletionInfo | null;
  parallelStatus?: ParallelStatusInfo | null;
  workers: WorkerInfo[];
  mergeItems: MergeQueueItem[];
  conflict: ConflictInfo | null;
  exitArmed?: boolean;
}

export function ParallelExecutionView({
  state,
  selectedTaskIndex,
  navMode,
  detailFocus,
  parallel,
  parallelCompletion,
  parallelStatus,
  workers,
  mergeItems,
  conflict,
  exitArmed,
}: ParallelExecutionViewProps): ReactNode {
  const [, tick] = useState(0);
  useEffect(() => {
    if (state.engineState !== "executing" && state.engineState !== "reviewing") return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [state.engineState]);

  const { width, height } = useTerminalDimensions();
  const bodyHeight = Math.max(1, height - layout.header.height - layout.footer.height);
  const done = state.tasks.filter((t) => t.status === "done").length;

  // Top row: left column + output pane (right)
  const sidebarWidth = Math.max(
    layout.sidebar.minWidth,
    Math.min(layout.sidebar.maxWidth, Math.floor(width * layout.sidebar.defaultWidthPercent / 100)),
  );
  const outputWidth = width - sidebarWidth;

  // Bottom row for workers + conflict resolution
  const hasConflict = conflict !== null;
  const minTopHeight = 8;
  const maxBottomHeight = Math.max(0, bodyHeight - minTopHeight);
  const conflictRows = conflict
    ? conflict.files.length + 2 + (conflict.summary ? 2 : 0)
    : 0;
  const minBottomHeight = conflict ? 6 : 3;
  const desiredBottomHeight = Math.max(minBottomHeight, workers.length + 2, conflictRows);
  const bottomHeight = Math.min(desiredBottomHeight, Math.min(12, maxBottomHeight));
  const topHeight = bodyHeight - bottomHeight;

  // Split left column: TaskSidebar on top, MergeQueuePanel below (hide sidebar when no tasks)
  const showTaskSidebar = state.tasks.length > 0;
  const minTaskSidebarHeight = showTaskSidebar ? 3 : 0;
  const desiredMergePanelHeight = Math.max(6, mergeItems.length + 2);
  const maxMergePanelHeight = showTaskSidebar ? Math.max(0, topHeight - minTaskSidebarHeight) : topHeight;
  const mergePanelHeight = showTaskSidebar
    ? Math.min(desiredMergePanelHeight, maxMergePanelHeight)
    : topHeight;
  const taskSidebarHeight = showTaskSidebar ? Math.max(0, topHeight - mergePanelHeight) : 0;

  // Bottom row widths: workers panel gets more space when no conflict
  const workersWidth = hasConflict ? Math.floor(width * 0.55) : width;
  const conflictWidth = hasConflict ? width - workersWidth : 0;

  // Determine selected task for output pane
  const clampedIndex = Math.min(selectedTaskIndex, Math.max(0, state.tasks.length - 1));
  const selectedTask = state.tasks[clampedIndex] ?? null;
  const isSelectedTaskActive = selectedTask?.id === state.currentTaskId;
  const isSelectedTaskRunning = selectedTask?.status === "in_progress";

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
  const outputCacheKey = selectedTask
    ? `${selectedTask.id}:${isSelectedTaskActive ? "active" : "stored"}`
    : "none";
  const outputSignature = `${displayOutput.length}:${displayOutput.slice(-256)}`;

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
      <box flexDirection="column" height={bodyHeight}>
        <box flexDirection="row" height={topHeight}>
          <box flexDirection="column" width={sidebarWidth} height={topHeight}>
            {showTaskSidebar && (
              <TaskSidebar
                tasks={state.tasks}
                currentTaskId={state.currentTaskId}
                selectedTaskIndex={clampedIndex}
                width={sidebarWidth}
                height={taskSidebarHeight}
              />
            )}
            <MergeQueuePanel
              items={mergeItems}
              width={sidebarWidth}
              height={mergePanelHeight}
            />
          </box>
          <OutputPane
            output={displayOutput}
            outputCacheKey={outputCacheKey}
            outputSignature={outputSignature}
            width={outputWidth}
            height={topHeight}
            isThinking={showThinking}
            currentPhase={showPhase}
            phaseStartTime={showPhaseStartTime}
            task={selectedTask}
            outputScrollFocused={navMode === "output-scroll"}
            outputFocused={outputFocused}
            taskDetailFocused={taskDetailFocused}
            taskDetailScrollFocused={navMode === "task-detail-scroll"}
            autoScroll={navMode !== "output-scroll" && (isSelectedTaskActive || isSelectedTaskRunning)}
          />
        </box>
        <box flexDirection="row" height={bottomHeight}>
          <WorkerPanel
            workers={workers}
            width={workersWidth}
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
        exitArmed={exitArmed}
      />
    </box>
  );
}
