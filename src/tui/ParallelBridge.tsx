import { useState, useEffect, useCallback, type ReactNode } from "react";
import { App } from "./App.js";
import type { TuiEngineData } from "./types.js";
import type { ParallelTuiState } from "../finalize/parallel-bridge.js";

function useTuiBridge(tuiData: TuiEngineData) {
  const [, tick] = useState(0);
  const notify = useCallback(() => tick((n) => n + 1), []);

  useEffect(() => {
    tuiData._notify = notify;
    return () => { tuiData._notify = undefined; };
  }, [tuiData, notify]);
}

interface ParallelBridgeProps {
  tuiData: TuiEngineData;
  parallelState: ParallelTuiState;
  onQuit: () => void;
}

export function ParallelBridge({ tuiData, parallelState, onQuit }: ParallelBridgeProps): ReactNode {
  useTuiBridge(tuiData);

  return (
    <App
      {...tuiData}
      parallel={parallelState.header}
      workers={parallelState.workers}
      mergeItems={parallelState.mergeItems}
      conflict={parallelState.conflict}
      onQuit={onQuit}
    />
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
