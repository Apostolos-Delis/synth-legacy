import { memo, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { LogSubscriber } from "../../logging/types.js";
import { LogView } from "../LogView.js";
import { colors } from "../theme.js";

export interface LogOverlayProps {
  visible: boolean;
  filter?: string;
  onSubscribe?: (subscriber: LogSubscriber) => () => void;
}

export const LogOverlay = memo(function LogOverlay({
  visible,
  filter,
  onSubscribe,
}: LogOverlayProps): ReactNode {
  const { width, height } = useTerminalDimensions();

  if (!visible) {
    return null;
  }

  const marginX = 4;
  const marginY = 2;
  const innerWidth = Math.max(40, width - marginX * 2);
  const innerHeight = Math.max(8, height - marginY * 2);
  const footerHeight = 1;
  const logHeight = Math.max(6, innerHeight - footerHeight);
  const filterText = filter ?? "";

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#000000B3",
      }}
    >
      <box style={{ flexDirection: "column", width: innerWidth, height: innerHeight }}>
        <LogView
          width={innerWidth}
          height={logHeight}
          focused={true}
          filter={filterText}
          onSubscribe={onSubscribe}
        />
        <box style={{ paddingLeft: 1, paddingTop: 0 }}>
          <text>
            <span fg={colors.fg.muted}>filter:</span>
            <span fg={colors.fg.primary}> {filterText || " "}</span>
            <span fg={colors.fg.muted}>  esc:close  ctrl+u:clear</span>
          </text>
        </box>
      </box>
    </box>
  );
});
