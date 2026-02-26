import type { ReactNode } from "react";
import type { AgentToolEvent } from "../../agents/types.js";
import { colors } from "../theme.js";
import { getToolEventDisplay } from "../../utils/tool-format.js";

interface AgentStreamingBodyProps {
  streamingText: string;
  toolEvents: AgentToolEvent[];
  paddingLeft?: number;
}

export function AgentStreamingBody({
  streamingText,
  toolEvents,
  paddingLeft = 2,
}: AgentStreamingBodyProps): ReactNode {
  const visibleToolEvents = toolEvents.slice(-1);

  return (
    <box style={{ paddingLeft, flexDirection: "column" }}>
      {streamingText && (
        <text fg={colors.fg.muted}>{streamingText.replace(/\s+$/, "")}</text>
      )}
      {visibleToolEvents.length > 0 && (
        <box style={{ flexDirection: "column", gap: 0 }}>
          {visibleToolEvents.map((event, idx) => {
            const display = getToolEventDisplay(event);
            const isUse = event.kind === "use";
            const labelColor = isUse ? colors.status.info : colors.status.success;

            return (
              <box key={`${event.kind}-${display.name}-${idx}`} style={{ flexDirection: "column" }}>
                <text>
                  <span fg={labelColor}>{display.kindLabel}</span>
                  <span fg={colors.fg.muted}>{` ${display.kindText} `}</span>
                  <span fg={colors.accent.primary}>{display.name}</span>
                  {display.id && <span fg={colors.fg.dim}>{display.id}</span>}
                </text>
                {display.input && (
                  <text>
                    <span fg={colors.fg.muted}>  input:</span>
                    <span fg={colors.fg.dim}>{` ${display.input}`}</span>
                  </text>
                )}
                {display.output && (
                  <text>
                    <span fg={colors.fg.muted}>  output:</span>
                    <span fg={colors.fg.dim}>{` ${display.output}`}</span>
                  </text>
                )}
              </box>
            );
          })}
        </box>
      )}
    </box>
  );
}
