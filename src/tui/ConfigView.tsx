import { useCallback, type ReactNode } from "react";
import { useTerminalDimensions, useKeyboard } from "@opentui/react";
import type { TuiState } from "./types.js";
import { boldAttr, colors } from "./theme.js";
import { Footer } from "./components/Footer.js";

interface ConfigViewProps {
  state: TuiState;
  onBack: () => void;
}

export function ConfigView({ state, onBack }: ConfigViewProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const lines = state.configDisplay.split("\n");
  const bodyHeight = Math.max(1, height - 2);

  const handleKey = useCallback(
    (key: { name: string }) => {
      if (key.name === "escape") {
        onBack();
      }
      // j/k scroll handled by scrollbox
    },
    [onBack],
  );

  useKeyboard(handleKey);

  return (
    <box width={width} height={height} flexDirection="column">
      <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text>
          <span fg={colors.accent.primary} attributes={boldAttr()}>Config</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.secondary}>merged configuration (read-only)</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.muted}>j/k:scroll  esc:back</span>
        </text>
      </box>
      <scrollbox height={bodyHeight} stickyScroll={false} stickyStart="top" style={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
        {lines.map((line, i) => {
          // Colorize JSON keys vs values
          const keyMatch = line.match(/^(\s*)"([^"]+)":/);
          if (keyMatch) {
            const [, indent, key] = keyMatch;
            const rest = line.slice(keyMatch[0].length);
            return (
              <text key={i}>
                <span fg={colors.fg.muted}>{indent}</span>
                <span fg={colors.accent.primary}>"{key}"</span>
                <span fg={colors.fg.muted}>:</span>
                <span fg={colors.fg.primary}>{rest}</span>
              </text>
            );
          }
          return (
            <text key={i}>
              <span fg={colors.fg.primary}>{line}</span>
            </text>
          );
        })}
      </scrollbox>
      <Footer view="config" width={width} />
    </box>
  );
}
