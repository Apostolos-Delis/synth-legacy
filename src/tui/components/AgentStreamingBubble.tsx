import type { ReactNode } from "react";
import { boldAttr, colors } from "../theme.js";
import { PhaseIndicator } from "./PhaseIndicator.js";
import type { AgentToolEvent } from "../../agents/types.js";
import { AgentStreamingBody } from "./AgentStreamingBody.js";

interface AgentStreamingBubbleProps {
  isLoading: boolean;
  loadingStartTime: number;
  streamingText: string;
  toolEvents: AgentToolEvent[];
  phaseLabel: string;
}

export function AgentStreamingBubble({
  isLoading,
  loadingStartTime,
  streamingText,
  toolEvents,
  phaseLabel,
}: AgentStreamingBubbleProps): ReactNode {
  if (!isLoading) return null;
  const isStreaming = streamingText.length > 0 || toolEvents.length > 0;
  const phase = isStreaming ? "Streaming response..." : phaseLabel;

  return (
    <box style={{ width: "100%", flexDirection: "column", marginBottom: 1 }}>
      <box style={{ flexDirection: "row", gap: 1 }}>
        <text fg={colors.accent.secondary} attributes={boldAttr()}>Synth</text>
        <PhaseIndicator phase={phase} startTime={loadingStartTime} />
      </box>
      {isStreaming && (
        <AgentStreamingBody
          streamingText={streamingText}
          toolEvents={toolEvents}
        />
      )}
    </box>
  );
}
