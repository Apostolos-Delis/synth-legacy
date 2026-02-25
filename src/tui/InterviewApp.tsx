import { useState, useCallback, useRef, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";
import type { InterviewMessage } from "../interview/types.js";
import type { AgentToolEvent } from "../agents/types.js";
import { WELCOME_MESSAGE } from "../interview/interviewer.js";
import { boldAttr, colors, markdownSyntaxStyle } from "./theme.js";
import { PhaseIndicator } from "./components/PhaseIndicator.js";
import { AgentStreamingBubble } from "./components/AgentStreamingBubble.js";
import { openInEditor } from "../utils/editor.js";
import { copyToClipboard } from "../utils/clipboard.js";
import { formatDuration } from "../utils/format.js";

import { useDestroyedRef } from "./hooks/useDestroyedRef.js";
import { useSyncLineCount } from "./hooks/useSyncLineCount.js";
import { calcInputSizing } from "./hooks/useInputSizing.js";
import { useAgentStreaming } from "./hooks/useAgentStreaming.js";
import { useExitConfirm } from "./hooks/useExitConfirm.js";

interface InterviewAppProps {
  sessionId?: string;
  onSendMessage: (msg: string, onChunk: (chunk: string) => void, onTool?: (event: AgentToolEvent) => void) => Promise<{ response: string; done: boolean }>;
  onComplete: () => void;
  onQuit: () => void;
  initialMessages?: InterviewMessage[];
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

export function InterviewApp({ sessionId, onSendMessage, onComplete, onQuit, initialMessages }: InterviewAppProps): ReactNode {
  const [messages, setMessages] = useState<InterviewMessage[]>(
    initialMessages && initialMessages.length > 0
      ? [{ role: "assistant", content: WELCOME_MESSAGE }, ...initialMessages]
      : [{ role: "assistant", content: WELCOME_MESSAGE }],
  );
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStartTime, setLoadingStartTime] = useState(0);
  const {
    streamingText,
    toolEvents,
    hasStreaming,
    appendChunk,
    appendTool,
    reset: resetStreaming,
  } = useAgentStreaming();

  const textareaRef = useRef<TextareaRenderable>(null);
  const { height: termHeight } = useTerminalDimensions();
  const renderer = useRenderer();
  const editorOpenRef = useRef(false);

  const destroyedRef = useDestroyedRef();
  const { inputLineCount, setInputLineCount, syncLineCount } = useSyncLineCount(textareaRef, destroyedRef);
  const { exitArmed, requestQuit } = useExitConfirm();

  const handleSubmit = useCallback(async () => {
    if (isLoading) return;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const value = (textarea.plainText ?? "").trim();

    if (value.toLowerCase() === "q" || value.toLowerCase() === "quit") {
      onQuit();
      return;
    }



    if (!value) return;

    textarea.editBuffer.setText("");
    setInputLineCount(1);
    const userMsg: InterviewMessage = { role: "user", content: value };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);
    const startTime = Date.now();
    setLoadingStartTime(startTime);
    resetStreaming();

    try {
      const { response, done } = await onSendMessage(value, appendChunk, appendTool);
      resetStreaming();
      const elapsed = Date.now() - startTime;
      const durationLabel = elapsed > 0 ? `\n\n_Generated in ${formatDuration(elapsed)}_` : "";
      const assistantMsg: InterviewMessage = { role: "assistant", content: `${response}${durationLabel}` };
      setMessages((prev) => [...prev, assistantMsg]);
      setIsLoading(false);

      if (done) {
        onComplete();
        return;
      }
    } catch (err) {
      resetStreaming();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Agent failed to respond"}` },
      ]);
      setIsLoading(false);
    }
  }, [isLoading, onSendMessage, onComplete, onQuit]);

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

    // Cmd+C — copy selected text (or last assistant message) to clipboard
    if (key.name === "c" && key.meta) {
      key.preventDefault?.();
      const selected = textarea?.hasSelection() ? textarea.getSelectedText() : null;
      if (selected) {
        copyToClipboard(selected);
      } else {
        const lastAssistant = messages.filter((m) => m.role === "assistant").at(-1);
        if (lastAssistant) copyToClipboard(lastAssistant.content);
      }
      return;
    }

    // Ctrl+E — force-proceed (execute)
    if (key.name === "e" && key.ctrl && !isLoading) {
      key.preventDefault?.();
      onComplete();
      return;
    }

    // Escape or Ctrl+C to quit
    if (key.name === "escape") {
      if (requestQuit()) onQuit();
      return;
    }
    if (key.name === "c" && key.ctrl) {
      if (requestQuit()) onQuit();
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
  }, [handleSubmit, onComplete, onQuit, isLoading, syncLineCount, renderer, messages, requestQuit]));

  const { inputHeight, textareaHeight } = calcInputSizing(termHeight, inputLineCount);
  const headerHeight = 3;
  const hintHeight = 1;
  const messageAreaHeight = Math.max(1, termHeight - headerHeight - inputHeight - hintHeight);
  const messageScrollHeight = Math.max(1, messageAreaHeight - 1);

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
          <text fg={colors.accent.primary} attributes={boldAttr()}>synth session</text>
          <text fg={colors.fg.muted}>PRD Interview</text>
          {sessionId ? <text fg={colors.fg.muted}>{sessionId}</text> : null}
        </box>
        <text fg={colors.fg.muted}>
          {messages.length} message{messages.length !== 1 ? "s" : ""}
        </text>
      </box>

      {/* Message area */}
      <box
        style={{
          height: messageAreaHeight,
          flexDirection: "column",
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
        }}
      >
        <scrollbox height={messageScrollHeight} stickyScroll={true} stickyStart="bottom">
          {messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} />
          ))}
          <AgentStreamingBubble
            isLoading={isLoading}
            loadingStartTime={loadingStartTime}
            streamingText={streamingText}
            toolEvents={toolEvents}
            phaseLabel="Generating response..."
          />


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
            placeholder={isLoading ? "Waiting for response..." : "Type your message..."}
            focused={!isLoading}
          />
        </box>

      </box>

      {/* Hint bar - below the input area */}
      <box
        style={{
          width: "100%",
          height: 1,
          flexDirection: "row",
          justifyContent: "center",
          alignItems: "center",
          gap: 1,
          paddingLeft: 2,
          paddingRight: 2,
        }}
      >
        {exitArmed ? (
          <text fg={colors.status.warning}>Press Esc again to quit</text>
        ) : isLoading ? (
          <PhaseIndicator
            phase={hasStreaming ? "Streaming response..." : "Generating response..."}
            startTime={loadingStartTime}
          />
        ) : (
          <text fg={colors.fg.muted}>Enter:send  Shift+Enter:newline  Ctrl+E:proceed  Ctrl+G:editor  Ctrl+W:del word  Esc:quit</text>
        )}
      </box>
    </box>
  );
}
