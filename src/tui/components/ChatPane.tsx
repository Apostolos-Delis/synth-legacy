import type { ReactNode } from "react";
import type { InterviewMessage } from "../../interview/types.js";
import { colors } from "../theme.js";
import { Spinner } from "./Spinner.js";

interface ChatPaneProps {
  messages: InterviewMessage[];
  width: number;
  height: number;
  isThinking?: boolean;
}

export function ChatPane({ messages, width, height, isThinking }: ChatPaneProps): ReactNode {
  return (
    <box
      width={width}
      height={height}
      border={true}
      borderColor={colors.border.normal}
      flexDirection="column"
    >
      <scrollbox
        flexGrow={1}
        stickyScroll={true}
        stickyStart="bottom"
        style={{ flexDirection: "column" }}
      >
        {messages.map((msg, i) => {
          const isUser = msg.role === "user";
          const roleColor = isUser ? colors.status.info : colors.accent.secondary;
          const roleLabel = isUser ? "You" : "Synth";
          const lines = msg.content.split("\n");

          return (
            <box key={i} flexDirection="column">
              <text>
                <span fg={roleColor} attributes={1}>{roleLabel}:</span>
                <span fg={colors.fg.primary}> {lines[0]}</span>
              </text>
              {lines.slice(1).map((line, j) => (
                <text key={j}>
                  <span fg={colors.fg.secondary}>  {line}</span>
                </text>
              ))}
              <text>{""}</text>
            </box>
          );
        })}
        {isThinking && <Spinner label="Thinking..." color={colors.accent.secondary} />}
      </scrollbox>
    </box>
  );
}
