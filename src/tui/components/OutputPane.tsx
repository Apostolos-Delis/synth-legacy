import type { ReactNode } from "react";
import { colors } from "../theme.js";

interface OutputPaneProps {
  output: string;
  width: number;
  height: number;
}

export function OutputPane({ output, width, height }: OutputPaneProps): ReactNode {
  // Show the last N lines that fit in the pane
  const lines = output.split("\n");
  const visibleLines = lines.slice(-(height - 1));

  return (
    <box width={width} height={height} flexDirection="column">
      <text>{colors.bold} Output{colors.reset}</text>
      {visibleLines.map((line, i) => (
        <text key={i}>{` ${line.slice(0, width - 2)}`}</text>
      ))}
    </box>
  );
}
