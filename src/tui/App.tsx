import { useState, useCallback, useRef, useEffect, memo, type ReactNode } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { TuiState, TuiEngineData, ViewMode, NavMode } from "./types.js";
import { ExecutionView } from "./ExecutionView.js";
import { ParallelExecutionView } from "./ParallelExecutionView.js";
import { DashboardView } from "./DashboardView.js";
import { HistoryView } from "./HistoryView.js";
import { ConfigView } from "./ConfigView.js";
import { CompletionView } from "./CompletionView.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { ToastContainer } from "./components/Toast.js";
import { useToast } from "./hooks/useToast.js";
import { useExitConfirm } from "./hooks/useExitConfirm.js";
import type { ParallelHeaderInfo, ParallelCompletionInfo } from "./components/Header.js";
import type { ParallelStatusInfo } from "./components/StatusBar.js";
import type { WorkerInfo } from "./components/WorkerPanel.js";
import type { MergeQueueItem } from "./components/MergeQueuePanel.js";
import type { ConflictInfo } from "./components/ConflictResolutionPanel.js";
import { startSpan, endSpan, countEvent } from "./profiler.js";

interface AppProps extends TuiEngineData {
  defaultView?: ViewMode;
  onQuit?: () => void;
  onFinalize?: () => void;
  onReviewStart?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  parallel?: ParallelHeaderInfo | null;
  parallelCompletion?: ParallelCompletionInfo | null;
  parallelStatus?: ParallelStatusInfo | null;
  workers?: WorkerInfo[];
  mergeItems?: MergeQueueItem[];
  conflict?: ConflictInfo | null;
}

export const App = memo(function App({
  defaultView = "execution",
  onQuit,
  onFinalize,
  onReviewStart,
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
  const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
  const [navMode, setNavMode] = useState<NavMode>("task-scroll");
  const [detailFocus, setDetailFocus] = useState<"task" | "output">("task");
  const { toasts, showSuccess, showInfo, showWarning } = useToast();
  const { exitArmed, requestQuit } = useExitConfirm();
  const renderSpan = startSpan("App");

  useEffect(() => {
    countEvent("app:mount");
    return () => {
      countEvent("app:unmount");
    };
  }, []);

  // Hide cursor — no text input fields exist in execution/dashboard/completion views
  const renderer = useRenderer();
  useEffect(() => {
    renderer.setCursorPosition(0, 0, false);
  }, [renderer]);

  // Use refs for modal states and view so the key handler callback stays stable
  const showHelpRef = useRef(showHelp);
  showHelpRef.current = showHelp;
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
  const prevSelectedIndexRef = useRef(selectedTaskIndex);
  prevSelectedIndexRef.current = selectedTaskIndex;
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
        countEvent("tui:auto-follow");
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

  useEffect(() => {
    if (prevSelectedIndexRef.current !== selectedTaskIndex) {
      countEvent("tui:selected-index-change");
      if (selectedTaskIndex === 0) countEvent("tui:selected-index-zero");
      prevSelectedIndexRef.current = selectedTaskIndex;
    }
  }, [selectedTaskIndex]);

  // engineData is a new object every render (rest-spread from props), so
  // useMemo with [engineData] can't cache — build inline instead.
  const executionState: TuiState = { ...engineData, view: "execution" as ViewMode };

  const attemptQuit = useCallback(() => {
    if (requestQuit()) {
      onQuit?.();
      return;
    }
    showWarning("Press q/esc again to quit");
  }, [onQuit, requestQuit, showWarning]);

  const handleKeyboard = useCallback(
    (key: { name: string; ctrl?: boolean; meta?: boolean }) => {
      // Help overlay takes precedence
      if (showHelpRef.current) {
        if (key.name === "?" || key.name === "escape") {
          setShowHelp(false);
        }
        return;
      }

      // Completion view responds to q/Esc to quit, Enter to review, and f to finalize
      if (viewRef.current === "completion") {
        if (key.name === "q" || key.name === "escape") {
          attemptQuit();
        } else if (key.name === "return") {
          if (onReviewStart) {
            onReviewStart();
          } else if (onFinalize) {
            onFinalize();
          }
        } else if (key.name === "f" && onFinalize) {
          onFinalize();
        }
        return;
      }

      // Cmd+C — allow system copy, do not treat as quit
      if (key.name === "c" && key.meta) {
        return;
      }

      // Ctrl+C shows quit confirmation
      if (key.name === "c" && key.ctrl) {
        attemptQuit();
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
            countEvent("tui:manual-select");
            setSelectedTaskIndex((i) => Math.min(i + 1, taskCount - 1));
            return;
          }
          if (key.name === "k" || key.name === "up") {
            countEvent("tui:manual-select");
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
            attemptQuit();
          }
          break;
        case "escape":
          if (viewRef.current === "dashboard") {
            setView("execution");
          } else {
            attemptQuit();
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
    [attemptQuit, onFinalize, onReviewStart, onPause, onResume],
  );

  useKeyboard(handleKeyboard);

  // Completion view replaces execution/dashboard when summary is ready
  if (view === "completion" && engineData.completionSummary) {
    const { progress } = engineData.completionSummary;
    const allDone = progress.failed === 0 && progress.open === 0 && progress.inProgress === 0;
    endSpan("App", renderSpan);
    return (
      <box style={{ width: "100%", height: "100%", position: "relative" }}>
        <CompletionView
          summary={engineData.completionSummary}
          showFinalizePrompt={allDone && !!onFinalize}
          showReviewPrompt={allDone && !!onReviewStart}
          reviewStatus={engineData.reviewStatus}
        />
      </box>
    );
  }

  endSpan("App", renderSpan);
  return (
    <box style={{ width: "100%", height: "100%", position: "relative" }}>
      {view === "execution" && (
        parallel ? (
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
            exitArmed={exitArmed}
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
            exitArmed={exitArmed}
          />
        )
      )}
      {view === "dashboard" && <DashboardView state={{ ...engineData, view: "dashboard" }} />}
      {view === "history" && <HistoryView state={{ ...engineData, view: "history" }} onBack={() => setView("execution")} />}
      {view === "config" && <ConfigView state={{ ...engineData, view: "config" }} onBack={() => setView("execution")} />}
      <ToastContainer toasts={toasts} />
      <HelpOverlay visible={showHelp} />
    </box>
  );
}, (prev, next) =>
  // Only re-render when data that affects the view actually changes.
  // The _notify mechanism re-renders SerialBridge which spreads tuiData,
  // creating new prop references even when values haven't changed.
  prev.engineState === next.engineState &&
  prev.output === next.output &&
  prev.tasks === next.tasks &&
  prev.currentTaskId === next.currentTaskId &&
  prev.isThinking === next.isThinking &&
  prev.currentPhase === next.currentPhase &&
  prev.phaseStartTime === next.phaseStartTime &&
  prev.iteration === next.iteration &&
  prev.completionSummary === next.completionSummary &&
  prev.tokenUsage === next.tokenUsage &&
  prev.onQuit === next.onQuit &&
  prev.onFinalize === next.onFinalize &&
  prev.onReviewStart === next.onReviewStart &&
  prev.parallel === next.parallel &&
  prev.parallelCompletion === next.parallelCompletion &&
  prev.parallelStatus === next.parallelStatus &&
  prev.reviewStatus === next.reviewStatus,
);

export type { TuiState, TuiEngineData };
