import { useState, useEffect, memo, type ReactNode } from "react";
import { SPINNER_FRAMES, colors } from "../theme.js";

interface SpinnerProps {
  label?: string;
  color?: string;
}

export const Spinner = memo(function Spinner({ label, color }: SpinnerProps): ReactNode {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 200);
    return () => clearInterval(interval);
  }, []);

  const fg = color ?? colors.accent.primary;

  return (
    <text>
      <span fg={fg}>{SPINNER_FRAMES[frame]}</span>
      {label ? ` ${label}` : ""}
    </text>
  );
});
