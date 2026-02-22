import { useState, useEffect, type ReactNode } from "react";
import { colors } from "../theme.js";
import { Spinner } from "./Spinner.js";

interface PhaseIndicatorProps {
  phase: string;
  startTime: number;
}

export function PhaseIndicator({ phase, startTime }: PhaseIndicatorProps): ReactNode {
  const [elapsed, setElapsed] = useState(Math.floor((Date.now() - startTime) / 1000));

  useEffect(() => {
    setElapsed(Math.floor((Date.now() - startTime) / 1000));
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <box flexDirection="row" height={1} gap={1}>
      <Spinner color={colors.accent.primary} />
      <text>
        <span fg={colors.fg.primary}>{phase}</span>
        <span fg={colors.fg.muted}> {elapsed}s</span>
      </text>
    </box>
  );
}
