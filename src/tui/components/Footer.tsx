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
};

export function Footer({ view, width }: FooterProps): ReactNode {
  return (
    <box width={width} height={1}>
      <text>{` ${colors.muted}${SHORTCUTS[view]}${colors.reset}`}</text>
    </box>
  );
}
