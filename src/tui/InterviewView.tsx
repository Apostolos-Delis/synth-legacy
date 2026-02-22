import { useState, useCallback, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { TuiState } from "./types.js";
import { colors, layout } from "./theme.js";
import { ChatPane } from "./components/ChatPane.js";

interface InterviewViewProps {
  state: TuiState;
  onSubmit?: (value: string) => void;
  onQuit?: () => void;
}

export function InterviewView({ state, onSubmit, onQuit }: InterviewViewProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const [inputValue, setInputValue] = useState("");
  // header(1) + chat + input(1) + footer(1)
  const chatHeight = height - layout.header.height - layout.footer.height - 1;

  const handleSubmit = useCallback(() => {
    const value = inputValue.trim();
    if (!value) return;
    if (value.toLowerCase() === "q" || value.toLowerCase() === "quit") {
      onQuit?.();
      return;
    }
    setInputValue("");
    onSubmit?.(value);
  }, [inputValue, onSubmit, onQuit]);

  return (
    <box width={width} height={height} flexDirection="column">
      <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text>
          <span fg={colors.accent.primary} attributes={1}>synth plan</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.secondary}>PRD Interview</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.muted}>{state.interviewMessages.length} messages</span>
        </text>
      </box>
      <ChatPane
        messages={state.interviewMessages}
        width={width}
        height={chatHeight}
        isThinking={state.isThinking}
      />
      <input
        focused={true}
        placeholder="Type your response... (q to quit)"
        value={inputValue}
        onInput={setInputValue}
        onSubmit={handleSubmit}
        width={width}
        style={{ backgroundColor: colors.bg.highlight }}
      />
      <box width={width} height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text>
          <span fg={colors.fg.muted}>Enter:send  q:quit</span>
        </text>
      </box>
    </box>
  );
}
