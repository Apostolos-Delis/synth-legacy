import { useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import type { TuiState, TuiEngineData, ViewMode } from "./types.js";
import { ExecutionView } from "./ExecutionView.js";
import { DashboardView } from "./DashboardView.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { ConfirmationDialog } from "./components/ConfirmationDialog.js";
import { ToastContainer } from "./components/Toast.js";
import { useToast } from "./hooks/useToast.js";

interface AppProps extends TuiEngineData {
  defaultView?: ViewMode;
  onQuit?: () => void;
  onPause?: () => void;
  onResume?: () => void;
}

export function App({
  defaultView = "execution",
  onQuit,
  onPause,
  onResume,
  ...engineData
}: AppProps): ReactNode {
  const [view, setView] = useState<ViewMode>(defaultView);
  const [showHelp, setShowHelp] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const { toasts, showSuccess, showInfo, showWarning } = useToast();

  // Use refs for modal states and view so the key handler callback stays stable
  const showHelpRef = useRef(showHelp);
  showHelpRef.current = showHelp;
  const showQuitConfirmRef = useRef(showQuitConfirm);
  showQuitConfirmRef.current = showQuitConfirm;
  const viewRef = useRef(view);
  viewRef.current = view;
  const engineStateRef = useRef(engineData.engineState);
  engineStateRef.current = engineData.engineState;

  const prevEngineState = useRef(engineData.engineState);
  useEffect(() => {
    const prev = prevEngineState.current;
    const curr = engineData.engineState;
    if (prev === curr) return;
    prevEngineState.current = curr;

    if (curr === "completed") showSuccess("All tasks complete!");
    else if (curr === "paused" && prev === "executing") showInfo("Execution paused");
    else if (curr === "blocked") showWarning("Execution blocked");
  }, [engineData.engineState, showSuccess, showInfo, showWarning]);

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
    (key: { name: string; ctrl?: boolean }) => {
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

      // Ctrl+C shows confirmation during execution
      if (key.name === "c" && key.ctrl && engineStateRef.current === "executing") {
        setShowQuitConfirm(true);
        return;
      }

      switch (key.name) {
        case "?":
          setShowHelp(true);
          break;
        case "q":
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
        case "p":
          if (engineStateRef.current === "executing") {
            onPause?.();
          } else if (engineStateRef.current === "paused") {
            onResume?.();
          }
          break;
      }
    },
    [onQuit, onPause, onResume],
  );

  useKeyboard(handleKeyboard);

  // Render both views — active view gets full size, inactive gets hidden.
  // This avoids mount/unmount cycles on view switch for single-frame transitions.
  const isDashboard = view === "dashboard";

  return (
    <box style={{ width: "100%", height: "100%", position: "relative" }}>
      <box style={isDashboard ? hiddenStyle : visibleStyle}>
        <ExecutionView state={executionState} />
      </box>
      <box style={isDashboard ? visibleStyle : hiddenStyle}>
        <DashboardView state={dashboardState} />
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
