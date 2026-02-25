import { useCallback, useState } from "react";
import type { AgentToolEvent } from "../../agents/types.js";

export function useAgentStreaming() {
  const [streamingText, setStreamingText] = useState("");
  const [toolEvents, setToolEvents] = useState<AgentToolEvent[]>([]);

  const reset = useCallback(() => {
    setStreamingText("");
    setToolEvents([]);
  }, []);

  const setStreaming = useCallback((text: string, events: AgentToolEvent[] = []) => {
    setStreamingText(text);
    setToolEvents(events);
  }, []);

  const appendChunk = useCallback((chunk: string) => {
    if (!chunk) return;
    setStreamingText((prev) => prev + chunk);
  }, []);

  const appendTool = useCallback((event: AgentToolEvent) => {
    setToolEvents((prev) => [...prev, event]);
  }, []);

  const hasStreaming = streamingText.length > 0 || toolEvents.length > 0;

  return {
    streamingText,
    toolEvents,
    hasStreaming,
    appendChunk,
    appendTool,
    reset,
    setStreaming,
  };
}
