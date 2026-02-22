import type { ReactNode } from "react";
import { colors } from "../theme.js";

interface OutputPaneProps {
  output: string;
  width: number;
  height: number;
}

export function OutputPane({ output, width, height }: OutputPaneProps): ReactNode {
  const lines = output.split("\n");

  return (
    <box
      width={width}
      height={height}
      border={true}
      borderColor={colors.border.normal}
      title="Output"
      flexDirection="column"
    >
      <scrollbox
        flexGrow={1}
        stickyScroll={true}
        stickyStart="bottom"
        style={{ flexDirection: "column" }}
      >
        {lines.map((line, i) => (
          <text key={i}>
            <span fg={colors.fg.secondary}>{line}</span>
          </text>
        ))}
      </scrollbox>
    </box>
  );
}
