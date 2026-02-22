import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useTerminalDimensions, useKeyboard } from "@opentui/react";
import type { InterviewMessage } from "../interview/types.js";
import { colors, layout, SPINNER_FRAMES } from "./theme.js";

interface InterviewAppProps {
  opening: string;
  onSendMessage: (msg: string) => Promise<{ response: string; done: boolean }>;
  onComplete: () => void;
  onQuit: () => void;
}

function AnimatedSpinner(): ReactNode {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(interval);
  }, []);
  return <text fg={colors.status.info}>{SPINNER_FRAMES[frame]}</text>;
}

function MessageBubble({ message }: { message: InterviewMessage }): ReactNode {
  const isUser = message.role === "user";
  const roleColor = isUser ? colors.accent.primary : colors.accent.secondary;
  const roleLabel = isUser ? "You" : "Synth";

  return (
    <box style={{ width: "100%", flexDirection: "column", marginBottom: 1 }}>
      <text>
        <span fg={roleColor} attributes={1}>{roleLabel}</span>
      </text>
      <box style={{ paddingLeft: 2 }}>
        <text fg={colors.fg.primary}>{message.content}</text>
      </box>
    </box>
  );
}

export function InterviewApp({ opening, onSendMessage, onComplete, onQuit }: InterviewAppProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const [messages, setMessages] = useState<InterviewMessage[]>([
    { role: "assistant", content: opening },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("");
  const textareaRef = useRef<any>(null);

  const handleSubmit = useCallback(async () => {
    if (isLoading) return;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const value = (textarea.plainText ?? "").trim();
    if (!value) return;

    if (value.toLowerCase() === "q" || value.toLowerCase() === "quit") {
      onQuit();
      return;
    }

    // Clear input and add user message
    textarea.editBuffer.setText("");
    const userMsg: InterviewMessage = { role: "user", content: value };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);
    setLoadingStatus("Thinking...");

    try {
      const { response, done } = await onSendMessage(value);
      const assistantMsg: InterviewMessage = { role: "assistant", content: response };
      setMessages((prev) => [...prev, assistantMsg]);
      setIsLoading(false);
      setLoadingStatus("");

      if (done) {
        onComplete();
      }
    } catch {
      setIsLoading(false);
      setLoadingStatus("");
    }
  }, [isLoading, onSendMessage, onComplete, onQuit]);

  useKeyboard(useCallback((key: { name: string; shift?: boolean; ctrl?: boolean; meta?: boolean }) => {
    if (key.name === "return" && !key.shift && !key.ctrl && !key.meta) {
      handleSubmit();
    }
  }, [handleSubmit]));

  // Layout: header(1) + chat(flex) + textarea(6) + footer(1)
  const inputHeight = 6;
  const chatHeight = height - layout.header.height - inputHeight - layout.footer.height;

  return (
    <box width={width} height={height} flexDirection="column">
      {/* Header */}
      <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text>
          <span fg={colors.accent.primary} attributes={1}>synth plan</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.secondary}>PRD Interview</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.muted}>{messages.length} messages</span>
        </text>
      </box>

      {/* Chat area */}
      <box height={chatHeight} border={true} borderColor={colors.border.normal}>
        <scrollbox
          flexGrow={1}
          stickyScroll={true}
          stickyStart="bottom"
          style={{ flexDirection: "column", padding: 1 }}
        >
          {messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} />
          ))}
          {isLoading && (
            <box style={{ flexDirection: "row", gap: 1, marginBottom: 1 }}>
              <text fg={colors.accent.secondary}>Synth</text>
              <AnimatedSpinner />
              <text fg={colors.fg.muted}>{loadingStatus}</text>
            </box>
          )}
        </scrollbox>
      </box>

      {/* Input area */}
      <box height={inputHeight} border={true} borderColor={isLoading ? colors.border.muted : colors.border.active}>
        <textarea
          ref={textareaRef}
          style={{
            flexGrow: 1,
          }}
          placeholder={isLoading ? "Waiting for response..." : "Type your message... (Enter to send, q to quit)"}
          focused={!isLoading}
        />
      </box>

      {/* Footer */}
      <box width={width} height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text>
          {isLoading ? (
            <>
              <AnimatedSpinner />
              <span fg={colors.status.info}>{` ${loadingStatus}`}</span>
            </>
          ) : (
            <span fg={colors.fg.muted}>Enter:send  Shift+Enter:newline  q:quit</span>
          )}
        </text>
      </box>
    </box>
  );
}
