import { useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { TuiState, TuiEngineData, ViewMode, NavMode } from "./types.js";
import { ExecutionView } from "./ExecutionView.js";
import { ParallelExecutionView } from "./ParallelExecutionView.js";
import { DashboardView } from "./DashboardView.js";
import { HistoryView } from "./HistoryView.js";
import { ConfigView } from "./ConfigView.js";
import { CompletionView } from "./CompletionView.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { ConfirmationDialog } from "./components/ConfirmationDialog.js";
import { ToastContainer } from "./components/Toast.js";
import { useToast } from "./hooks/useToast.js";
import type { ParallelHeaderInfo, ParallelCompletionInfo } from "./components/Header.js";
import type { ParallelStatusInfo } from "./components/StatusBar.js";
import type { WorkerInfo } from "./components/WorkerPanel.js";
import type { MergeQueueItem } from "./components/MergeQueuePanel.js";
import type { ConflictInfo } from "./components/ConflictResolutionPanel.js";

interface AppProps extends TuiEngineData {
  defaultView?: ViewMode;
  onQuit?: () => void;
  onFinalize?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  parallel?: ParallelHeaderInfo | null;
  parallelCompletion?: ParallelCompletionInfo | null;
  parallelStatus?: ParallelStatusInfo | null;
  workers?: WorkerInfo[];
  mergeItems?: MergeQueueItem[];
  conflict?: ConflictInfo | null;
}

export function App({
  defaultView = "execution",
  onQuit,
  onFinalize,
  onPause,
  onResume,
  parallel,
  parallelCompletion,
  parallelStatus,
  workers = [],
  mergeItems = [],
  conflict = null,
  ...engineData
}: AppProps): ReactNode {
  const [view, setView] = useState<ViewMode>(defaultView);
  const [showHelp, setShowHelp] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
  const [navMode, setNavMode] = useState<NavMode>("task-scroll");
  const [detailFocus, setDetailFocus] = useState<"task" | "output">("task");
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
  const detailFocusRef = useRef(detailFocus);
  detailFocusRef.current = detailFocus;
  const selectedTaskIndexRef = useRef(selectedTaskIndex);
  selectedTaskIndexRef.current = selectedTaskIndex;
  const tasksRef = useRef(engineData.tasks);
  tasksRef.current = engineData.tasks;
  const parallelRef = useRef(parallel);
  parallelRef.current = parallel;

  const prevEngineState = useRef(engineData.engineState);
  useEffect(() => {
    const prev = prevEngineState.current;
    const curr = engineData.engineState;
    if (prev === curr) return;
    prevEngineState.current = curr;

    if (curr === "completed" && !engineData.completionSummary) showSuccess("All tasks complete!");
    else if (curr === "reviewing") showInfo("Starting review phase...");
    else if (curr === "paused" && prev === "executing") showInfo("Execution paused");
    else if (curr === "blocked") showWarning("Execution blocked");
  }, [engineData.engineState, engineData.completionSummary, showSuccess, showInfo, showWarning]);

  // Reset selection to active task when a new task starts executing (serial mode only).
  // In parallel mode, currentTaskId bounces between workers rapidly — auto-following
  // would override the user's manual j/k selection every few seconds.
  const prevTaskId = useRef(engineData.currentTaskId);
  useEffect(() => {
    if (parallelRef.current) {
      prevTaskId.current = engineData.currentTaskId;
      return;
    }
      if (engineData.currentTaskId && engineData.currentTaskId !== prevTaskId.current) {
        const idx = engineData.tasks.findIndex((t) => t.id === engineData.currentTaskId);
        if (idx >= 0) {
          setSelectedTaskIndex(idx);
          setNavMode("task-scroll");
          setDetailFocus("task");
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

  // engineData is a new object every render (rest-spread from props), so
  // useMemo with [engineData] never caches.  Build state objects inline instead
  // — the real protection comes from React.memo on child components.
  const executionState: TuiState = { ...engineData, view: "execution" as ViewMode };
  const dashboardState: TuiState = { ...engineData, view: "dashboard" as ViewMode };
  const historyState: TuiState = { ...engineData, view: "history" as ViewMode };
  const configState: TuiState = { ...engineData, view: "config" as ViewMode };

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

      // Ctrl+C shows confirmation during execution, or is ignored otherwise
      if (key.name === "c" && key.ctrl) {
        if (engineStateRef.current === "executing") {
          setShowQuitConfirm(true);
        }
        return;
      }

      // Execution view navigation (j/k/arrows/enter/escape/w/m)
      if (viewRef.current === "execution") {
        const taskCount = tasksRef.current.length;
        const isParallel = !!parallelRef.current;

        // 'w' toggles between WorkerPanel and OutputPane in parallel mode
        if (key.name === "w" && isParallel) {
          setNavMode((m) => m === "worker-panel" ? "output-scroll" : "worker-panel");
          return;
        }

        // 'm' toggles merge queue panel in parallel mode
        if (key.name === "m" && isParallel) {
          setNavMode((m) => m === "merge-panel" ? "task-scroll" : "merge-panel");
          return;
        }

        // Tab cycles through parallel panels: worker -> output -> merge -> conflict -> worker
        if (key.name === "tab" && isParallel) {
          setNavMode((m) => {
            if (m === "worker-panel") return "output-scroll";
            if (m === "output-scroll") return "merge-panel";
            if (m === "merge-panel") return "conflict-panel";
            if (m === "conflict-panel") return "worker-panel";
            return "worker-panel";
          });
          return;
        }

        if (navModeRef.current === "detail-select") {
          if (key.name === "escape") {
            setNavMode("task-scroll");
            return;
          }
          if (key.name === "j" || key.name === "down") {
            setDetailFocus("output");
            return;
          }
          if (key.name === "k" || key.name === "up") {
            setDetailFocus("task");
            return;
          }
          if (key.name === "return") {
            setNavMode(detailFocusRef.current === "output" ? "output-scroll" : "task-detail-scroll");
            return;
          }
        }

        if (navModeRef.current === "task-detail-scroll") {
          if (key.name === "escape") {
            setNavMode("task-scroll");
            return;
          }
          if (key.name === "j" || key.name === "k" || key.name === "up" || key.name === "down") {
            return;
          }
        }

        if (navModeRef.current === "worker-panel") {
          if (key.name === "escape") {
            setNavMode("task-scroll");
            return;
          }
          // In worker-panel mode, don't intercept j/k/arrows
          if (key.name === "j" || key.name === "k" || key.name === "up" || key.name === "down") {
            return;
          }
        }

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

        if (navModeRef.current === "merge-panel") {
          if (key.name === "escape") {
            setNavMode("task-scroll");
            return;
          }
          if (key.name === "j" || key.name === "k" || key.name === "up" || key.name === "down") {
            return;
          }
        }

        if (navModeRef.current === "conflict-panel") {
          if (key.name === "escape") {
            setNavMode("task-scroll");
            return;
          }
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
            setDetailFocus("task");
            setNavMode("detail-select");
            return;
          }
        }
      }

      // History and config views handle their own keyboard events
      if (viewRef.current === "history" || viewRef.current === "config") {
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
        case "c":
          setView((v) => (v === "config" ? "execution" : "config"));
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

  // Render views — active view gets full size, others hidden.
  const isExecution = view === "execution";
  const isDashboard = view === "dashboard";
  const isHistory = view === "history";
  const isConfig = view === "config";

  return (
    <box style={{ width: "100%", height: "100%", position: "relative" }}>
      <box style={isExecution ? visibleStyle : hiddenStyle}>
        {parallel ? (
          <ParallelExecutionView
            state={executionState}
            selectedTaskIndex={selectedTaskIndex}
            navMode={navMode}
            detailFocus={detailFocus}
            parallel={parallel}
            parallelCompletion={parallelCompletion}
            parallelStatus={parallelStatus}
            workers={workers}
            mergeItems={mergeItems}
            conflict={conflict}
          />
        ) : (
          <ExecutionView
            state={executionState}
            selectedTaskIndex={selectedTaskIndex}
            navMode={navMode}
            detailFocus={detailFocus}
            parallel={parallel}
            parallelCompletion={parallelCompletion}
            parallelStatus={parallelStatus}
          />
        )}
      </box>
      <box style={isDashboard ? visibleStyle : hiddenStyle}>
        <DashboardView state={dashboardState} />
      </box>
      <box style={isHistory ? visibleStyle : hiddenStyle}>
        <HistoryView state={historyState} onBack={() => setView("execution")} />
      </box>
      <box style={isConfig ? visibleStyle : hiddenStyle}>
        <ConfigView state={configState} onBack={() => setView("execution")} />
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
