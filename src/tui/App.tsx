import { useState, useCallback, useMemo, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import type { TuiState, TuiEngineData, ViewMode } from "./types.js";
import { ExecutionView } from "./ExecutionView.js";
import { DashboardView } from "./DashboardView.js";
import { InterviewView } from "./InterviewView.js";

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

  const state: TuiState = useMemo(
    () => ({ ...engineData, view }),
    [engineData, view],
  );

  const handleKeyboard = useCallback(
    (key: { name: string }) => {
      switch (key.name) {
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
    [view, engineData.engineState, onQuit, onPause, onResume],
  );

  useKeyboard(handleKeyboard);

  switch (view) {
    case "interview":
      return <InterviewView state={state} />;
    case "dashboard":
      return <DashboardView state={state} />;
    case "execution":
    default:
      return <ExecutionView state={state} />;
  }
}

export type { TuiState, TuiEngineData };
