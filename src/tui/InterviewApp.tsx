import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";
import type { InterviewMessage } from "../interview/types.js";
import { WELCOME_MESSAGE } from "../interview/interviewer.js";
import { boldAttr, colors, SPINNER_FRAMES } from "./theme.js";

interface InterviewAppProps {
  onSendMessage: (msg: string, onChunk: (chunk: string) => void) => Promise<{ response: string; done: boolean }>;
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
        <text fg={roleColor} attributes={boldAttr()}>{roleLabel}</text>
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
  const [streamingText, setStreamingText] = useState("");
  const textareaRef = useRef<TextareaRenderable>(null);

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
    setStreamingText("");

    try {
      const { response, done } = await onSendMessage(value, (chunk) => {
        setStreamingText((prev) => prev + chunk);
      });
      setStreamingText("");
      const assistantMsg: InterviewMessage = { role: "assistant", content: response };
      setMessages((prev) => [...prev, assistantMsg]);
      setIsLoading(false);

      if (done) {
        onComplete();
      }
    } catch {
      setStreamingText("");
      setIsLoading(false);
    }
  }, [isLoading, onSendMessage, onComplete, onQuit]);

  useKeyboard(useCallback((key: { name: string; shift?: boolean; ctrl?: boolean; meta?: boolean; option?: boolean; preventDefault?: () => void }) => {
    const textarea = textareaRef.current;

    // Enter to send
    if (key.name === "return" && !key.shift && !key.ctrl && !key.meta) {
      key.preventDefault?.();
      handleSubmit();
      return;
    }

    // Shift+Enter or Ctrl+J for newline
    if ((key.name === "return" && key.shift) || (key.name === "j" && key.ctrl)) {
      key.preventDefault?.();
      textarea?.newLine();
      return;
    }

    // Escape or Ctrl+C to quit
    if (key.name === "escape") {
      onQuit();
      return;
    }
    if (key.name === "c" && key.ctrl) {
      onQuit();
      return;
    }

    // Text editing shortcuts (only when textarea is available and not loading)
    if (!textarea || isLoading) return;

    // Ctrl+W / Option+Backspace — delete word backward
    if ((key.ctrl && key.name === "w") || (key.option && key.name === "backspace")) {
      key.preventDefault?.();
      textarea.deleteWordBackward();
      return;
    }

    // Ctrl+U — kill to start of line
    if (key.ctrl && key.name === "u") {
      key.preventDefault?.();
      textarea.deleteToLineStart();
      return;
    }

    // Ctrl+K — kill to end of line
    if (key.ctrl && key.name === "k") {
      key.preventDefault?.();
      textarea.deleteToLineEnd();
      return;
    }

    // Option+Delete — delete word forward
    if (key.option && key.name === "delete") {
      key.preventDefault?.();
      textarea.deleteWordForward();
      return;
    }

    // Option+Left/Right — word movement
    if (key.option && !key.shift && key.name === "left") {
      key.preventDefault?.();
      textarea.moveWordBackward();
      return;
    }
    if (key.option && !key.shift && key.name === "right") {
      key.preventDefault?.();
      textarea.moveWordForward();
      return;
    }

    // Shift+Option+Left/Right — word selection
    if (key.shift && key.option && key.name === "left") {
      key.preventDefault?.();
      textarea.moveWordBackward({ select: true });
      return;
    }
    if (key.shift && key.option && key.name === "right") {
      key.preventDefault?.();
      textarea.moveWordForward({ select: true });
      return;
    }

    // Shift+arrow keys — text selection
    if (key.shift && !key.meta && !key.option && !key.ctrl) {
      if (key.name === "left") {
        key.preventDefault?.();
        textarea.moveCursorLeft({ select: true });
        return;
      }
      if (key.name === "right") {
        key.preventDefault?.();
        textarea.moveCursorRight({ select: true });
        return;
      }
      if (key.name === "up") {
        key.preventDefault?.();
        textarea.moveCursorUp({ select: true });
        return;
      }
      if (key.name === "down") {
        key.preventDefault?.();
        textarea.moveCursorDown({ select: true });
        return;
      }
    }
  }, [handleSubmit, onQuit, isLoading]));

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
          <text fg={colors.accent.primary} attributes={boldAttr()}>synth plan</text>
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
            <box style={{ width: "100%", flexDirection: "column", marginBottom: 1 }}>
              <box style={{ flexDirection: "row", gap: 1 }}>
                <text fg={colors.accent.secondary} attributes={boldAttr()}>Synth</text>
                {!streamingText && <AnimatedSpinner />}
              </box>
              {streamingText ? (
                <box style={{ paddingLeft: 2 }}>
                  <text fg={colors.fg.primary}>{streamingText}</text>
                </box>
              ) : (
                <box style={{ paddingLeft: 2 }}>
                  <text fg={colors.fg.muted}>Thinking...</text>
                </box>
              )}
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
        <box
          style={{
            flexGrow: 1,
            flexDirection: "row",
            alignItems: "flex-start",
          }}
        >
          <text fg={colors.accent.primary} style={{ paddingTop: 0 }}>
            {">"}{" "}
          </text>
          <textarea
            ref={textareaRef}
            style={{ flexGrow: 1 }}
            placeholder={isLoading ? "Waiting for response..." : "Type your message..."}
            focused={!isLoading}
          />
        </box>

        {/* Hint bar - positioned on bottom border */}
        <box
          style={{
            position: "absolute",
            bottom: 0,
            left: 2,
            right: 2,
            height: 1,
            flexDirection: "row",
            justifyContent: "center",
            alignItems: "center",
            gap: 1,
            backgroundColor: colors.bg.secondary,
          }}
        >
          {isLoading ? (
            <>
              <AnimatedSpinner />
              <text fg={colors.status.info}>{streamingText ? "Streaming..." : "Waiting for response..."}</text>
            </>
          ) : (
            <text fg={colors.fg.muted}>Enter:send  Shift+Enter:newline  Ctrl+W:del word  Esc:quit</text>
          )}
        </box>
      </box>
    </box>
  );
}
