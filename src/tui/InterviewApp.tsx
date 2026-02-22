import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { createTextAttributes } from "@opentui/core";
import type { InterviewMessage } from "../interview/types.js";
import { WELCOME_MESSAGE } from "../interview/interviewer.js";
import { colors, SPINNER_FRAMES } from "./theme.js";

const boldAttr = createTextAttributes({ bold: true });

interface InterviewAppProps {
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
      <box style={{ flexDirection: "row", gap: 1 }}>
        <text fg={roleColor} attributes={boldAttr}>{roleLabel}</text>
      </box>
      <box style={{ paddingLeft: 2 }}>
        <text fg={colors.fg.primary}>{message.content}</text>
      </box>
    </box>
  );
}

export function InterviewApp({ onSendMessage, onComplete, onQuit }: InterviewAppProps): ReactNode {
  const [messages, setMessages] = useState<InterviewMessage[]>([
    { role: "assistant", content: WELCOME_MESSAGE },
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
    } else if (key.name === "escape") {
      onQuit();
    } else if (key.name === "c" && key.ctrl) {
      onQuit();
    }
  }, [handleSubmit, onQuit]));

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
      {/* Header */}
      <box
        style={{
          width: "100%",
          height: 3,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          backgroundColor: colors.bg.secondary,
          paddingLeft: 1,
          paddingRight: 1,
          border: true,
          borderColor: colors.border.normal,
        }}
      >
        <box style={{ flexDirection: "row", gap: 2 }}>
          <text fg={colors.accent.primary} attributes={boldAttr}>synth plan</text>
          <text fg={colors.fg.muted}>PRD Interview</text>
        </box>
        <text fg={colors.fg.muted}>
          {messages.length} message{messages.length !== 1 ? "s" : ""}
        </text>
      </box>

      {/* Message area */}
      <box
        style={{
          flexGrow: 1,
          flexDirection: "column",
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
        }}
      >
        <scrollbox style={{ flexGrow: 1 }} stickyScroll={true} stickyStart="bottom">
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
      <box
        style={{
          width: "100%",
          height: 8,
          flexDirection: "column",
          backgroundColor: colors.bg.secondary,
          border: true,
          borderColor: isLoading ? colors.border.normal : colors.border.active,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <textarea
          ref={textareaRef}
          style={{ flexGrow: 1 }}
          placeholder={isLoading ? "Waiting for response..." : "Type your message... (Enter to send, q to quit)"}
          focused={!isLoading}
        />
      </box>

      {/* Footer */}
      <box
        style={{
          width: "100%",
          height: 1,
          backgroundColor: colors.bg.secondary,
          paddingLeft: 1,
        }}
      >
        {isLoading ? (
          <box style={{ flexDirection: "row", gap: 1 }}>
            <AnimatedSpinner />
            <text fg={colors.status.info}>{loadingStatus}</text>
          </box>
        ) : (
          <text fg={colors.fg.muted}>Enter:send  Shift+Enter:newline  Esc:quit</text>
        )}
      </box>
    </box>
  );
}
