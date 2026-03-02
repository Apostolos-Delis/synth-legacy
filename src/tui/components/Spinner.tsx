import { memo, type ReactNode } from "react";
import { SPINNER_FRAMES, colors } from "../theme.js";
import { useAnimationTick } from "../hooks/useAnimationTick.js";

interface SpinnerProps {
  label?: string;
  color?: string;
}

export const Spinner = memo(function Spinner({ label, color }: SpinnerProps): ReactNode {
  const { spinnerFrame } = useAnimationTick();

  const fg = color ?? colors.accent.primary;

  return (
    <text>
      <span fg={fg}>{SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}</span>
      {label ? ` ${label}` : ""}
    </text>
  );
});
