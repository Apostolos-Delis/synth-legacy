import { useState, useCallback, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import type { TuiState } from "./types.js";
import { ExecutionView } from "./ExecutionView.js";
import { DashboardView } from "./DashboardView.js";
import { InterviewView } from "./InterviewView.js";

interface AppProps {
  initialState: TuiState;
  onQuit?: () => void;
  onPause?: () => void;
  onResume?: () => void;
}

export function App({
  initialState,
  onQuit,
  onPause,
  onResume,
}: AppProps): ReactNode {
  const [state, setState] = useState<TuiState>(initialState);

  const handleKeyboard = useCallback(
    (key: { name: string }) => {
      switch (key.name) {
        case "q":
        case "escape":
          if (state.view === "dashboard") {
            setState((s) => ({ ...s, view: "execution" }));
          } else {
            onQuit?.();
          }
          break;
        case "d":
          setState((s) => ({
            ...s,
            view: s.view === "dashboard" ? "execution" : "dashboard",
          }));
          break;
        case "p":
          if (state.engineState === "executing") {
            onPause?.();
          } else if (state.engineState === "paused") {
            onResume?.();
          }
          break;
      }
    },
    [state.view, state.engineState, onQuit, onPause, onResume],
  );

  useKeyboard(handleKeyboard);

  switch (state.view) {
    case "interview":
      return <InterviewView state={state} />;
    case "dashboard":
      return <DashboardView state={state} />;
    case "execution":
    default:
      return <ExecutionView state={state} />;
  }
}

export type { TuiState };
