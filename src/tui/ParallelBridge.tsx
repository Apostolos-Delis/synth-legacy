import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { App } from "./App.js";
import { TaskGraphOverlay } from "./components/TaskGraphOverlay.js";
import type { TuiEngineData } from "./types.js";
import type { ParallelTuiState } from "../finalize/parallel-bridge.js";
import type { TaskGraphAnalysis } from "../parallel/task-graph.js";
import type { Task } from "../tasks/types.js";

function useTuiBridge(tuiData: TuiEngineData) {
  const [, tick] = useState(0);
  const notify = useCallback(() => tick((n) => n + 1), []);

  useEffect(() => {
    tuiData._notify = notify;
    return () => { tuiData._notify = undefined; };
  }, [tuiData, notify]);
}

export interface ParallelBridgeProps {
  tuiData: TuiEngineData;
  parallelState: ParallelTuiState;
  taskGraphAnalysis: TaskGraphAnalysis;
  onQuit: () => void;
}

export function ParallelBridge({ tuiData, parallelState, taskGraphAnalysis, onQuit }: ParallelBridgeProps): ReactNode {
  useTuiBridge(tuiData);

  const [showGraph, setShowGraph] = useState(false);
  const showGraphRef = useRef(showGraph);
  showGraphRef.current = showGraph;

  const taskStatuses = useMemo(() => {
    const statuses: Record<string, Task["status"]> = {};
    for (const task of tuiData.tasks) {
      statuses[task.id] = task.status;
    }
    for (const worker of parallelState.workers) {
      if (worker.taskId && worker.status === "running") {
        statuses[worker.taskId] = "in_progress";
      }
    }
    return statuses;
  }, [tuiData.tasks, parallelState.workers]);

  useKeyboard(
    useCallback((key: { name: string }) => {
      if (key.name === "g") {
        setShowGraph((s) => !s);
        return;
      }
      if (key.name === "escape" && showGraphRef.current) {
        setShowGraph(false);
      }
    }, []),
  );

  return (
    <box style={{ width: "100%", height: "100%", position: "relative" }}>
      <App
        {...tuiData}
        parallel={parallelState.header}
        workers={parallelState.workers}
        mergeItems={parallelState.mergeItems}
        conflict={parallelState.conflict}
        onQuit={showGraph ? undefined : onQuit}
      />
      <TaskGraphOverlay
        visible={showGraph}
        analysis={taskGraphAnalysis}
        taskStatuses={taskStatuses}
      />
    </box>
  );
}

interface SerialBridgeProps {
  tuiData: TuiEngineData;
  onQuit: () => void;
}

export function SerialBridge({ tuiData, onQuit }: SerialBridgeProps): ReactNode {
  useTuiBridge(tuiData);

  return <App {...tuiData} onQuit={onQuit} />;
}
