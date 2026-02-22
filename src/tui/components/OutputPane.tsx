import { useState, useEffect, type ReactNode } from "react";
import { colors, SPINNER_FRAMES } from "../theme.js";
import { stripAnsi } from "../utils.js";

interface OutputPaneProps {
  output: string;
  width: number;
  height: number;
  isThinking?: boolean;
}

export function OutputPane({ output, width, height, isThinking = false }: OutputPaneProps): ReactNode {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!isThinking || output) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [isThinking, output]);

  const clean = stripAnsi(output);

  if (isThinking && !clean) {
    return (
      <box
        width={width}
        height={height}
        border={true}
        borderColor={colors.border.normal}
        title="Output"
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
      >
        <text>
          <span fg={colors.accent.primary}>{SPINNER_FRAMES[frame]}</span>
          <span fg={colors.fg.muted}> Agent is working...</span>
        </text>
      </box>
    );
  }

  const lines = clean.split("\n");

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
