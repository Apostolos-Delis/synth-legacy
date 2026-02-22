import type { ReactNode } from "react";
import type { ViewMode } from "../types.js";
import { colors } from "../theme.js";

interface FooterProps {
  view: ViewMode;
  width: number;
}

const SHORTCUTS: Record<ViewMode, string> = {
  execution: "q:quit  p:pause/resume  d:dashboard",
  dashboard: "q:quit  p:pause/resume  Esc:back",
  interview: "Enter:send  q:quit",
  generating: "Please wait...",
  review: "Enter:start execution  Esc/q:save and quit",
};

export function Footer({ view, width }: FooterProps): ReactNode {
  return (
    <box
      width={width}
      height={1}
      style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}
    >
      <text>
        <span fg={colors.fg.muted}>{SHORTCUTS[view]}</span>
      </text>
    </box>
  );
}
