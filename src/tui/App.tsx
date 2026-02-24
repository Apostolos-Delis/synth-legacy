import { useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { TuiState, TuiEngineData, ViewMode, NavMode } from "./types.js";
import { ExecutionView } from "./ExecutionView.js";
import { DashboardView } from "./DashboardView.js";
import { HistoryView } from "./HistoryView.js";
import { CompletionView } from "./CompletionView.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { ConfirmationDialog } from "./components/ConfirmationDialog.js";
import { ToastContainer } from "./components/Toast.js";
import { useToast } from "./hooks/useToast.js";

interface AppProps extends TuiEngineData {
  defaultView?: ViewMode;
  onQuit?: () => void;
  onFinalize?: () => void;
  onPause?: () => void;
  onResume?: () => void;
}

export function App({
  defaultView = "execution",
  onQuit,
  onFinalize,
  onPause,
  onResume,
  ...engineData
}: AppProps): ReactNode {
  const [view, setView] = useState<ViewMode>(defaultView);
  const [showHelp, setShowHelp] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
  const [navMode, setNavMode] = useState<NavMode>("task-scroll");
  const { toasts, showSuccess, showInfo, showWarning } = useToast();

  // Hide cursor — no text input fields exist in execution/dashboard/completion views
  const renderer = useRenderer();
  useEffect(() => {
    renderer.setCursorPosition(0, 0, false);
  }, [renderer]);

  // Use refs for modal states and view so the key handler callback stays stable
  const showHelpRef = useRef(showHelp);
  showHelpRef.current = showHelp;
  const showQuitConfirmRef = useRef(showQuitConfirm);
  showQuitConfirmRef.current = showQuitConfirm;
  const viewRef = useRef(view);
  viewRef.current = view;
  const engineStateRef = useRef(engineData.engineState);
  engineStateRef.current = engineData.engineState;
  const navModeRef = useRef(navMode);
  navModeRef.current = navMode;
  const selectedTaskIndexRef = useRef(selectedTaskIndex);
  selectedTaskIndexRef.current = selectedTaskIndex;
  const tasksRef = useRef(engineData.tasks);
  tasksRef.current = engineData.tasks;

  const prevEngineState = useRef(engineData.engineState);
  useEffect(() => {
    const prev = prevEngineState.current;
    const curr = engineData.engineState;
    if (prev === curr) return;
    prevEngineState.current = curr;

    if (curr === "completed" && !engineData.completionSummary) showSuccess("All tasks complete!");
    else if (curr === "paused" && prev === "executing") showInfo("Execution paused");
    else if (curr === "blocked") showWarning("Execution blocked");
  }, [engineData.engineState, engineData.completionSummary, showSuccess, showInfo, showWarning]);

  // Reset selection to active task when a new task starts executing
  const prevTaskId = useRef(engineData.currentTaskId);
  useEffect(() => {
    if (engineData.currentTaskId && engineData.currentTaskId !== prevTaskId.current) {
      const idx = engineData.tasks.findIndex((t) => t.id === engineData.currentTaskId);
      if (idx >= 0) {
        setSelectedTaskIndex(idx);
        setNavMode("task-scroll");
      }
    }
    prevTaskId.current = engineData.currentTaskId;
  }, [engineData.currentTaskId, engineData.tasks]);

  // Auto-switch to completion view when summary is ready
  useEffect(() => {
    if (engineData.completionSummary && engineData.engineState === "completed") {
      setView("completion");
    }
  }, [engineData.completionSummary, engineData.engineState]);

  // Separate state objects per view so inactive view doesn't get new props
  const executionState: TuiState = useMemo(
    () => ({ ...engineData, view: "execution" as ViewMode }),
    [engineData],
  );
  const dashboardState: TuiState = useMemo(
    () => ({ ...engineData, view: "dashboard" as ViewMode }),
    [engineData],
  );

  const handleKeyboard = useCallback(
    (key: { name: string; ctrl?: boolean; meta?: boolean }) => {
      // Help overlay takes precedence
      if (showHelpRef.current) {
        if (key.name === "?" || key.name === "escape") {
          setShowHelp(false);
        }
        return;
      }

      // Quit confirmation dialog
      if (showQuitConfirmRef.current) {
        if (key.name === "y") {
          setShowQuitConfirm(false);
          onQuit?.();
        } else if (key.name === "n" || key.name === "escape") {
          setShowQuitConfirm(false);
        }
        return;
      }

      // Completion view responds to q/Esc to quit and f to finalize
      if (viewRef.current === "completion") {
        if (key.name === "q" || key.name === "escape") {
          onQuit?.();
        } else if (key.name === "f" && onFinalize) {
          onFinalize();
        }
        return;
      }

      // Cmd+C — allow system copy, do not treat as quit
      if (key.name === "c" && key.meta) {
        return;
      }

      // Ctrl+C shows confirmation during execution
      if (key.name === "c" && key.ctrl && engineStateRef.current === "executing") {
        setShowQuitConfirm(true);
        return;
      }

      // Execution view navigation (j/k/arrows/enter/escape)
      if (viewRef.current === "execution") {
        const taskCount = tasksRef.current.length;

        if (navModeRef.current === "output-scroll") {
          if (key.name === "escape") {
            setNavMode("task-scroll");
            return;
          }
          // In output-scroll, don't intercept j/k/arrows — scrollbox handles them
          if (key.name === "j" || key.name === "k" || key.name === "up" || key.name === "down") {
            return;
          }
        }

        if (navModeRef.current === "task-scroll" && taskCount > 0) {
          if (key.name === "j" || key.name === "down") {
            setSelectedTaskIndex((i) => Math.min(i + 1, taskCount - 1));
            return;
          }
          if (key.name === "k" || key.name === "up") {
            setSelectedTaskIndex((i) => Math.max(i - 1, 0));
            return;
          }
          if (key.name === "return") {
            setNavMode("output-scroll");
            return;
          }
        }
      }

      // History view handles its own keyboard events via useKeyboard
      if (viewRef.current === "history") {
        return;
      }

      switch (key.name) {
        case "?":
          setShowHelp(true);
          break;
        case "q":
          if (viewRef.current === "dashboard") {
            setView("execution");
          } else {
            onQuit?.();
          }
          break;
        case "escape":
          if (viewRef.current === "dashboard") {
            setView("execution");
          } else {
            onQuit?.();
          }
          break;
        case "d":
          setView((v) => (v === "dashboard" ? "execution" : "dashboard"));
          break;
        case "h":
          setView((v) => (v === "history" ? "execution" : "history"));
          break;
        case "p":
          if (engineStateRef.current === "executing") {
            onPause?.();
          } else if (engineStateRef.current === "paused") {
            onResume?.();
          }
          break;
      }
    },
    [onQuit, onFinalize, onPause, onResume],
  );

  useKeyboard(handleKeyboard);

  // Completion view replaces execution/dashboard when summary is ready
  if (view === "completion" && engineData.completionSummary) {
    const { progress } = engineData.completionSummary;
    const allDone = progress.failed === 0 && progress.open === 0 && progress.inProgress === 0;
    return (
      <box style={{ width: "100%", height: "100%", position: "relative" }}>
        <CompletionView summary={engineData.completionSummary} showFinalizePrompt={allDone && !!onFinalize} />
      </box>
    );
  }

  const historyState: TuiState = useMemo(
    () => ({ ...engineData, view: "history" as ViewMode }),
    [engineData],
  );

  // Render views — active view gets full size, others hidden.
  const isExecution = view === "execution";
  const isDashboard = view === "dashboard";
  const isHistory = view === "history";

  return (
    <box style={{ width: "100%", height: "100%", position: "relative" }}>
      <box style={isExecution ? visibleStyle : hiddenStyle}>
        <ExecutionView state={executionState} selectedTaskIndex={selectedTaskIndex} navMode={navMode} />
      </box>
      <box style={isDashboard ? visibleStyle : hiddenStyle}>
        <DashboardView state={dashboardState} />
      </box>
      <box style={isHistory ? visibleStyle : hiddenStyle}>
        <HistoryView state={historyState} onBack={() => setView("execution")} />
      </box>
      <ToastContainer toasts={toasts} />
      <HelpOverlay visible={showHelp} />
      <ConfirmationDialog
        visible={showQuitConfirm}
        title="Quit Synth?"
        message="Execution will be paused. You can resume later."
      />
    </box>
  );
}

// Static style objects to avoid re-creating on every render
const visibleStyle = { width: "100%" as const, height: "100%" as const };
const hiddenStyle = { width: 0, height: 0, overflow: "hidden" as const };

export type { TuiState, TuiEngineData };
