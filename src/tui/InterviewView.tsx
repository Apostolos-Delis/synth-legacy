import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { TuiState } from "./types.js";
import { colors } from "./theme.js";
import { ChatPane } from "./components/ChatPane.js";
import { Footer } from "./components/Footer.js";

interface InterviewViewProps {
  state: TuiState;
}

export function InterviewView({ state }: InterviewViewProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const chatHeight = height - 3;

  return (
    <box width={width} height={height} flexDirection="column">
      <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text>
          <span fg={colors.accent.primary} attributes={1}>synth plan</span>
          <span fg={colors.fg.muted}> \u2502 </span>
          <span fg={colors.fg.secondary}>PRD Interview</span>
          <span fg={colors.fg.muted}> \u2502 </span>
          <span fg={colors.fg.muted}>{state.interviewMessages.length} messages</span>
        </text>
      </box>
      <ChatPane
        messages={state.interviewMessages}
        width={width}
        height={chatHeight}
        isThinking={state.isThinking}
      />
      <Footer view="interview" width={width} />
    </box>
  );
}
