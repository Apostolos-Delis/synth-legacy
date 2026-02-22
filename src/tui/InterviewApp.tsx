import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";
import type { InterviewMessage } from "../interview/types.js";
import { WELCOME_MESSAGE } from "../interview/interviewer.js";
import { boldAttr, colors, markdownSyntaxStyle } from "./theme.js";
import { PhaseIndicator } from "./components/PhaseIndicator.js";
import { openInEditor } from "../utils/editor.js";

interface InterviewAppProps {
  onSendMessage: (msg: string, onChunk: (chunk: string) => void) => Promise<{ response: string; done: boolean }>;
  onComplete: () => void;
  onQuit: () => void;
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
        <markdown content={message.content} syntaxStyle={markdownSyntaxStyle()} />
      </box>
    </box>
  );
}

export function InterviewApp({ onSendMessage, onComplete, onQuit }: InterviewAppProps): ReactNode {
  const [messages, setMessages] = useState<InterviewMessage[]>([
    { role: "assistant", content: WELCOME_MESSAGE },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStartTime, setLoadingStartTime] = useState(0);
  const [streamingText, setStreamingText] = useState("");
  const [pendingConfirmation, setPendingConfirmation] = useState(false);
  const textareaRef = useRef<TextareaRenderable>(null);
  const [inputLineCount, setInputLineCount] = useState(1);
  const { height: termHeight } = useTerminalDimensions();
  const renderer = useRenderer();
  const editorOpenRef = useRef(false);

  const destroyedRef = useRef(false);
  useEffect(() => () => { destroyedRef.current = true; }, []);

  const syncLineCount = useCallback(() => {
    if (destroyedRef.current) return;
    try {
      const text = textareaRef.current?.plainText ?? "";
      setInputLineCount(Math.max(1, text.split("\n").length));
    } catch {
      // EditBuffer may be destroyed during shutdown
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (isLoading) return;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const value = (textarea.plainText ?? "").trim();

    if (value.toLowerCase() === "q" || value.toLowerCase() === "quit") {
      onQuit();
      return;
    }

    // Confirmation state: empty input = confirm, non-empty = continue refining
    if (pendingConfirmation) {
      if (!value) {
        onComplete();
        return;
      }
      // User typed feedback — continue the interview
      setPendingConfirmation(false);
    }

    if (!value) return;

    textarea.editBuffer.setText("");
    setInputLineCount(1);
    const userMsg: InterviewMessage = { role: "user", content: value };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);
    setLoadingStartTime(Date.now());
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
        setPendingConfirmation(true);
      }
    } catch {
      setStreamingText("");
      setIsLoading(false);
    }
  }, [isLoading, pendingConfirmation, onSendMessage, onComplete, onQuit]);

  useKeyboard(useCallback((key: { name: string; shift?: boolean; ctrl?: boolean; meta?: boolean; option?: boolean; preventDefault?: () => void }) => {
    const textarea = textareaRef.current;

    // Shift+Enter or Ctrl+J for newline — check BEFORE bare Enter
    // Ghostty (legacy mode) sends ESC CR for Shift+Enter → parsed as meta=true
    // Kitty protocol sends CSI 13;2u → parsed as shift=true
    // Ctrl+J sends \n → parsed as name="linefeed" in legacy mode
    if (
      (key.name === "return" && (key.shift || key.meta)) ||
      key.name === "linefeed" ||
      (key.name === "j" && key.ctrl)
    ) {
      key.preventDefault?.();
      textarea?.newLine();
      return;
    }

    // Enter to send (bare, unmodified)
    if (key.name === "return" && !key.shift && !key.ctrl && !key.meta) {
      key.preventDefault?.();
      handleSubmit();
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

    // Ctrl+G — open in $EDITOR
    if (key.name === "g" && key.ctrl) {
      key.preventDefault?.();
      if (!textarea || isLoading || editorOpenRef.current) return;
      editorOpenRef.current = true;
      const currentText = textarea.plainText ?? "";
      renderer.suspend();
      openInEditor(currentText).then((result) => {
        renderer.resume();
        editorOpenRef.current = false;
        if (result !== null && !destroyedRef.current) {
          textarea.editBuffer.setText(result);
          syncLineCount();
        }
      });
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
  }, [handleSubmit, onQuit, isLoading, syncLineCount, renderer]));

  // Sync line count after every key event (runs after textarea processes the key)
  useKeyboard(useCallback(() => {
    // Use setTimeout(0) so it runs after the textarea has processed the current key
    setTimeout(syncLineCount, 0);
  }, [syncLineCount]));

  // Input area grows with content, capped so header + a few message rows remain visible
  const BORDER = 2;          // top + bottom border
  const HEADER_HEIGHT = 3;
  const MIN_MESSAGES_VISIBLE = 3;
  const MIN_INPUT_HEIGHT = 6;
  const maxInputHeight = Math.max(MIN_INPUT_HEIGHT, termHeight - HEADER_HEIGHT - MIN_MESSAGES_VISIBLE);
  const inputHeight = Math.min(Math.max(inputLineCount + BORDER, MIN_INPUT_HEIGHT), maxInputHeight);
  // Explicit textarea height: total box minus borders, minus 1 row buffer so cursor never touches border
  const textareaHeight = inputHeight - BORDER - 1;

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
                {!streamingText && (
                  <PhaseIndicator
                    phase="Generating response..."
                    startTime={loadingStartTime}
                  />
                )}
              </box>
              {streamingText && (
                <box style={{ paddingLeft: 2 }}>
                  <markdown content={streamingText} syntaxStyle={markdownSyntaxStyle()} streaming={true} />
                </box>
              )}
            </box>
          )}
          {pendingConfirmation && !isLoading && (
            <box style={{ width: "100%", flexDirection: "column", marginBottom: 1, paddingLeft: 1 }}>
              <text fg={colors.status.info}>Does this all look good? Press Enter to generate the PRD and tasks, or type feedback to refine.</text>
            </box>
          )}
        </scrollbox>
      </box>

      {/* Input area */}
      <box
        style={{
          width: "100%",
          height: inputHeight,
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
            height: textareaHeight,
            flexDirection: "row",
            alignItems: "flex-start",
          }}
        >
          <text fg={colors.accent.primary} style={{ paddingTop: 0 }}>
            {">"}{" "}
          </text>
          <textarea
            ref={textareaRef}
            style={{ flexGrow: 1, height: textareaHeight }}
            placeholder={isLoading ? "Waiting for response..." : pendingConfirmation ? "Press Enter to confirm, or type feedback..." : "Type your message..."}
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
            <PhaseIndicator
              phase={streamingText ? "Streaming response..." : "Generating response..."}
              startTime={loadingStartTime}
            />
          ) : pendingConfirmation ? (
            <text fg={colors.status.info}>Enter:confirm & generate  Type feedback to refine  Esc:quit</text>
          ) : (
            <text fg={colors.fg.muted}>Enter:send  Shift+Enter:newline  Ctrl+G:editor  Ctrl+W:del word  Esc:quit</text>
          )}
        </box>
      </box>
    </box>
  );
}
