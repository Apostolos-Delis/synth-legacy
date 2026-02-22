import type { ReactNode } from "react";
import type { InterviewMessage } from "../../interview/types.js";
import { colors } from "../theme.js";

interface ChatPaneProps {
  messages: InterviewMessage[];
  width: number;
  height: number;
}

export function ChatPane({ messages, width, height }: ChatPaneProps): ReactNode {
  // Render messages, showing most recent ones that fit
  const rendered: string[] = [];
  for (const msg of messages) {
    const prefix =
      msg.role === "user"
        ? `${colors.primary}You:${colors.reset}`
        : `${colors.magenta}Synth:${colors.reset}`;
    const lines = msg.content.split("\n");
    rendered.push(`${prefix} ${lines[0]}`);
    for (const line of lines.slice(1)) {
      rendered.push(`  ${line}`);
    }
    rendered.push("");
  }

  const visible = rendered.slice(-(height - 1));

  return (
    <box width={width} height={height} flexDirection="column">
      {visible.map((line, i) => (
        <text key={i}>{` ${line.slice(0, width - 2)}`}</text>
      ))}
    </box>
  );
}
