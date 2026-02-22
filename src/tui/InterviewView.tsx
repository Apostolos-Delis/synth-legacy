import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { TuiState } from "./types.js";
import { ChatPane } from "./components/ChatPane.js";
import { Footer } from "./components/Footer.js";
import { colors } from "./theme.js";

interface InterviewViewProps {
  state: TuiState;
}

export function InterviewView({ state }: InterviewViewProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const chatHeight = height - 3; // header + input + footer

  return (
    <box width={width} height={height} flexDirection="column">
      <text>
        {` ${colors.bold}synth plan${colors.reset} ${colors.muted}│${colors.reset} PRD Interview ${colors.muted}│${colors.reset} ${state.interviewMessages.length} messages`}
      </text>
      <ChatPane
        messages={state.interviewMessages}
        width={width}
        height={chatHeight}
      />
      <text>{` ${colors.muted}─${colors.reset}`.repeat(Math.floor(width / 2))}</text>
      <Footer view="interview" width={width} />
    </box>
  );
}
