import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { App } from "./App.js";
import { TaskGraphOverlay } from "./components/TaskGraphOverlay.js";
import { LogOverlay } from "./components/LogOverlay.js";
import type { TuiEngineData } from "./types.js";
import type { ParallelTuiState } from "../finalize/parallel-bridge.js";
import type { TaskGraphAnalysis } from "../parallel/task-graph.js";
import type { Task } from "../tasks/types.js";
import type { LogSubscriber } from "../logging/types.js";

function useTuiBridge(tuiData: TuiEngineData) {
  const [, tick] = useState(0);
  const notify = useCallback(() => tick((n) => n + 1), []);

  useEffect(() => {
    tuiData._notify = notify;
    return () => { tuiData._notify = undefined; };
  }, [tuiData, notify]);
}

function isTypableChar(name: string): boolean {
  if (name.length === 1) return true;
  // Known punctuation key names that map to printable characters
  const punctuation = new Set([
    "space", "period", "comma", "semicolon", "colon",
    "slash", "backslash", "apostrophe", "quote",
    "bracketleft", "bracketright", "minus", "equal",
    "grave", "tilde", "exclamation", "at", "hash",
    "dollar", "percent", "caret", "ampersand", "asterisk",
    "parenleft", "parenright", "underscore", "plus",
    "braceleft", "braceright", "pipe", "less", "greater",
    "question",
  ]);
  return punctuation.has(name);
}

function charFromKeyName(name: string): string {
  if (name.length === 1) return name;
  if (name === "space") return " ";
  // For named punctuation, the first char of the name isn't the right char.
  // Since these come from the terminal, the sequence/name mapping varies.
  // The single-char check above handles the common case.
  return "";
}

export interface ParallelBridgeProps {
  tuiData: TuiEngineData;
  parallelState: ParallelTuiState;
  taskGraphAnalysis: TaskGraphAnalysis;
  onQuit: () => void;
  onLogSubscribe?: (subscriber: LogSubscriber) => () => void;
}

export function ParallelBridge({ tuiData, parallelState, taskGraphAnalysis, onQuit, onLogSubscribe }: ParallelBridgeProps): ReactNode {
  useTuiBridge(tuiData);

  const [showGraph, setShowGraph] = useState(false);
  const showGraphRef = useRef(showGraph);
  showGraphRef.current = showGraph;

  const [showLogs, setShowLogs] = useState(false);
  const showLogsRef = useRef(showLogs);
  showLogsRef.current = showLogs;

  const [logFilter, setLogFilter] = useState("");

  const taskStatuses = useMemo(() => {
    const statuses: Record<string, Task["status"]> = {};
    for (const task of tuiData.tasks) {
      statuses[task.id] = task.status;
    }
    return statuses;
  }, [tuiData.tasks]);

  useKeyboard(
    useCallback((key: { name: string; ctrl?: boolean }) => {
      // When log overlay is visible, absorb all keys
      if (showLogsRef.current) {
        if (key.name === "escape") {
          setShowLogs(false);
          return;
        }
        if (key.ctrl && key.name === "u") {
          setLogFilter("");
          return;
        }
        if (key.name === "backspace" || key.name === "delete") {
          setLogFilter((f) => f.slice(0, -1));
          return;
        }
        if (isTypableChar(key.name)) {
          const ch = charFromKeyName(key.name);
          if (ch) setLogFilter((f) => f + ch);
        }
        // Absorb all other keys
        return;
      }

      // When graph overlay is visible, absorb graph keys only
      if (showGraphRef.current) {
        if (key.name === "g") {
          setShowGraph(false);
          return;
        }
        if (key.name === "escape") {
          setShowGraph(false);
        }
        // Don't handle 'l' when graph is shown
        return;
      }

      // Neither overlay is shown
      if (key.name === "g") {
        setShowGraph(true);
        return;
      }
      if (key.name === "l") {
        setShowLogs(true);
        setLogFilter("");
      }
    }, []),
  );

  const overlayActive = showGraph || showLogs;

  return (
    <box style={{ width: "100%", height: "100%", position: "relative" }}>
      <App
        {...tuiData}
        parallel={parallelState.header}
        workers={parallelState.workers}
        mergeItems={parallelState.mergeItems}
        conflict={parallelState.conflict}
        onQuit={overlayActive ? undefined : onQuit}
      />
      <TaskGraphOverlay
        visible={showGraph}
        analysis={taskGraphAnalysis}
        taskStatuses={taskStatuses}
      />
      <LogOverlay
        visible={showLogs}
        filter={logFilter}
        onSubscribe={onLogSubscribe}
      />
    </box>
  );
}

interface SerialBridgeProps {
  tuiData: TuiEngineData;
  onQuit: () => void;
  onLogSubscribe?: (subscriber: LogSubscriber) => () => void;
}

export function SerialBridge({ tuiData, onQuit, onLogSubscribe }: SerialBridgeProps): ReactNode {
  useTuiBridge(tuiData);

  const [showLogs, setShowLogs] = useState(false);
  const showLogsRef = useRef(showLogs);
  showLogsRef.current = showLogs;

  const [logFilter, setLogFilter] = useState("");

  useKeyboard(
    useCallback((key: { name: string; ctrl?: boolean }) => {
      if (showLogsRef.current) {
        if (key.name === "escape") {
          setShowLogs(false);
          return;
        }
        if (key.ctrl && key.name === "u") {
          setLogFilter("");
          return;
        }
        if (key.name === "backspace" || key.name === "delete") {
          setLogFilter((f) => f.slice(0, -1));
          return;
        }
        if (isTypableChar(key.name)) {
          const ch = charFromKeyName(key.name);
          if (ch) setLogFilter((f) => f + ch);
        }
        return;
      }

      if (key.name === "l") {
        setShowLogs(true);
        setLogFilter("");
      }
    }, []),
  );

  return (
    <box style={{ width: "100%", height: "100%", position: "relative" }}>
      <App {...tuiData} onQuit={showLogs ? undefined : onQuit} />
      <LogOverlay
        visible={showLogs}
        filter={logFilter}
        onSubscribe={onLogSubscribe}
      />
    </box>
  );
}
