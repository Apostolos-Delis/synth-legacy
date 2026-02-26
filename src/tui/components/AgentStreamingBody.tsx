import type { ReactNode } from "react";
import type { AgentToolEvent } from "../../agents/types.js";
import { colors } from "../theme.js";

interface AgentStreamingBodyProps {
  streamingText: string;
  toolEvents: AgentToolEvent[];
  paddingLeft?: number;
}

const INPUT_LIMIT = 600;
const OUTPUT_LIMIT = 1200;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

function toDisplay(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
            const isUse = event.kind === "use";
            const kindLabel = isUse ? "→" : "←";
            const kindText = isUse ? "tool use" : "tool result";
            const name = event.name || "tool";
            const id = event.id ? ` ${event.id}` : "";
            const labelColor = isUse ? colors.status.info : colors.status.success;
            const input = event.input !== undefined ? truncate(toDisplay(event.input), INPUT_LIMIT) : "";
            const output = event.output !== undefined ? truncate(toDisplay(event.output), OUTPUT_LIMIT) : "";

            return (
              <box key={`${event.kind}-${name}-${idx}`} style={{ flexDirection: "column" }}>
                <text>
                  <span fg={labelColor}>{kindLabel}</span>
                  <span fg={colors.fg.muted}>{` ${kindText} `}</span>
                  <span fg={colors.accent.primary}>{name}</span>
                  {id && <span fg={colors.fg.dim}>{id}</span>}
                </text>
                {input && (
                  <text>
                    <span fg={colors.fg.muted}>  input:</span>
                    <span fg={colors.fg.dim}>{` ${input}`}</span>
                  </text>
                )}
                {output && (
                  <text>
                    <span fg={colors.fg.muted}>  output:</span>
                    <span fg={colors.fg.dim}>{` ${output}`}</span>
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
