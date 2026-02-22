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

  const state: TuiState = useMemo(
    () => ({ ...engineData, view }),
    [engineData, view],
  );

  const handleKeyboard = useCallback(
    (key: { name: string; ctrl?: boolean }) => {
      // Help overlay takes precedence
      if (showHelp) {
        if (key.name === "?" || key.name === "escape") {
          setShowHelp(false);
        }
        return;
      }

      // Quit confirmation dialog
      if (showQuitConfirm) {
        if (key.name === "y") {
          setShowQuitConfirm(false);
          onQuit?.();
        } else if (key.name === "n" || key.name === "escape") {
          setShowQuitConfirm(false);
        }
        return;
      }

      // Ctrl+C shows confirmation during execution
      if (key.name === "c" && key.ctrl && engineData.engineState === "executing") {
        setShowQuitConfirm(true);
        return;
      }

      switch (key.name) {
        case "?":
          setShowHelp(true);
          break;
        case "q":
        case "escape":
          if (view === "dashboard") {
            setView("execution");
          } else {
            onQuit?.();
          }
          break;
        case "d":
          setView((v) => (v === "dashboard" ? "execution" : "dashboard"));
          break;
        case "p":
          if (engineData.engineState === "executing") {
            onPause?.();
          } else if (engineData.engineState === "paused") {
            onResume?.();
          }
          break;
      }
    },
    [view, showHelp, showQuitConfirm, engineData.engineState, onQuit, onPause, onResume],
  );

  useKeyboard(handleKeyboard);

  return (
    <box style={{ width: "100%", height: "100%", position: "relative" }}>
      {view === "dashboard" ? (
        <DashboardView state={state} />
      ) : (
        <ExecutionView state={state} />
      )}
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

export type { TuiState, TuiEngineData };
