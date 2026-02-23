import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";
import type { FinalizeMessage, FinalizePhase, ChatOption } from "../finalize/chat-types.js";
import { boldAttr, colors, markdownSyntaxStyle } from "./theme.js";
import { PhaseIndicator } from "./components/PhaseIndicator.js";
import { OptionSelector } from "./components/OptionSelector.js";
import { openInEditor } from "../utils/editor.js";
import { copyToClipboard } from "../utils/clipboard.js";

interface FinalizeAppProps {
  messages: FinalizeMessage[];
  onSendMessage: (msg: string) => void;
  onSelectOption: (option: ChatOption) => void;
  onQuit: () => void;
  currentPhase: FinalizePhase;
  isLoading: boolean;
}

const PHASE_LABELS: Record<FinalizePhase, string> = {
  auditing: "Auditing PRD",
  discussing: "Discussing Issues",
  "collecting-fixes": "Collecting Fixes",
  "executing-fixes": "Executing Fixes",
  "creating-pr": "Creating PR",
  complete: "Complete",
};

function MessageBubble({ message }: { message: FinalizeMessage }): ReactNode {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const roleColor = isUser ? colors.accent.primary : isSystem ? colors.status.info : colors.accent.secondary;
  const roleLabel = isUser ? "You" : isSystem ? "System" : "Synth";

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

export function FinalizeApp({ messages, onSendMessage, onSelectOption, onQuit, currentPhase, isLoading }: FinalizeAppProps): ReactNode {
  const textareaRef = useRef<TextareaRenderable>(null);
  const [inputLineCount, setInputLineCount] = useState(1);
  const { height: termHeight } = useTerminalDimensions();
  const renderer = useRenderer();
  const editorOpenRef = useRef(false);
  const [loadingStartTime, setLoadingStartTime] = useState(0);

  const destroyedRef = useRef(false);
  useEffect(() => () => { destroyedRef.current = true; }, []);

  // Track loading start time
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    if (isLoading && !prevLoadingRef.current) {
      setLoadingStartTime(Date.now());
    }
    prevLoadingRef.current = isLoading;
  }, [isLoading]);

  const syncLineCount = useCallback(() => {
    if (destroyedRef.current) return;
    try {
      const text = textareaRef.current?.plainText ?? "";
      setInputLineCount(Math.max(1, text.split("\n").length));
    } catch {
      // EditBuffer may be destroyed during shutdown
    }
  }, []);

  // Determine if the last assistant message has options
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const showOptions = lastMessage?.role === "assistant" && lastMessage.options && lastMessage.options.length > 0 && !isLoading;

  const handleSubmit = useCallback(() => {
    if (isLoading || showOptions) return;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const value = (textarea.plainText ?? "").trim();
    if (!value) return;

    textarea.editBuffer.setText("");
    setInputLineCount(1);
    onSendMessage(value);
  }, [isLoading, showOptions, onSendMessage]);

  useKeyboard(useCallback((key: { name: string; shift?: boolean; ctrl?: boolean; meta?: boolean; option?: boolean; preventDefault?: () => void }) => {
    const textarea = textareaRef.current;

    // Shift+Enter or Ctrl+J for newline — check BEFORE bare Enter
    if (
      (key.name === "return" && (key.shift || key.meta)) ||
      key.name === "linefeed" ||
      (key.name === "j" && key.ctrl)
    ) {
      if (showOptions) return;
      key.preventDefault?.();
      textarea?.newLine();
      return;
    }

    // Enter to send (bare, unmodified) — only in freeform mode (OptionSelector handles its own Enter)
    if (key.name === "return" && !key.shift && !key.ctrl && !key.meta) {
      if (showOptions) return; // OptionSelector handles Enter
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

    // Escape or Ctrl+C to quit
    if (key.name === "escape") {
      onQuit();
      return;
    }
    if (key.name === "c" && key.ctrl) {
      onQuit();
      return;
    }

    // Ctrl+G — open in $EDITOR (only in freeform mode)
    if (key.name === "g" && key.ctrl) {
      key.preventDefault?.();
      if (!textarea || isLoading || editorOpenRef.current || showOptions) return;
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

    // Text editing shortcuts (only when textarea is available, not loading, and in freeform mode)
    if (!textarea || isLoading || showOptions) return;

    if ((key.ctrl && key.name === "w") || (key.option && key.name === "backspace")) {
      key.preventDefault?.();
      textarea.deleteWordBackward();
      return;
    }
    if (key.ctrl && key.name === "u") {
      key.preventDefault?.();
      textarea.deleteToLineStart();
      return;
    }
    if (key.ctrl && key.name === "k") {
      key.preventDefault?.();
      textarea.deleteToLineEnd();
      return;
    }
    if (key.option && key.name === "delete") {
      key.preventDefault?.();
      textarea.deleteWordForward();
      return;
    }
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
    if (key.shift && !key.meta && !key.option && !key.ctrl) {
      if (key.name === "left") { key.preventDefault?.(); textarea.moveCursorLeft({ select: true }); return; }
      if (key.name === "right") { key.preventDefault?.(); textarea.moveCursorRight({ select: true }); return; }
      if (key.name === "up") { key.preventDefault?.(); textarea.moveCursorUp({ select: true }); return; }
      if (key.name === "down") { key.preventDefault?.(); textarea.moveCursorDown({ select: true }); return; }
    }
  }, [handleSubmit, onQuit, isLoading, showOptions, syncLineCount, renderer, messages]));

  // Sync line count after every key event
  useKeyboard(useCallback(() => {
    setTimeout(syncLineCount, 0);
  }, [syncLineCount]));

  // Input area sizing
  const BORDER = 2;
  const HEADER_HEIGHT = 3;
  const MIN_MESSAGES_VISIBLE = 3;
  const MIN_INPUT_HEIGHT = 6;
  const maxInputHeight = Math.max(MIN_INPUT_HEIGHT, termHeight - HEADER_HEIGHT - MIN_MESSAGES_VISIBLE);
  const inputHeight = Math.min(Math.max(inputLineCount + BORDER, MIN_INPUT_HEIGHT), maxInputHeight);
  const textareaHeight = inputHeight - BORDER;

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
          <text fg={colors.accent.primary} attributes={boldAttr()}>synth finalize</text>
          <text fg={colors.fg.muted}>{PHASE_LABELS[currentPhase]}</text>
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
                <PhaseIndicator
                  phase={PHASE_LABELS[currentPhase]}
                  startTime={loadingStartTime}
                />
              </box>
            </box>
          )}
        </scrollbox>
      </box>

      {/* Input area */}
      {showOptions ? (
        <box
          style={{
            width: "100%",
            flexDirection: "column",
            backgroundColor: colors.bg.secondary,
            border: true,
            borderColor: colors.border.active,
            paddingLeft: 1,
            paddingRight: 1,
            paddingTop: 1,
            paddingBottom: 1,
          }}
        >
          <OptionSelector options={lastMessage!.options!} onSelect={onSelectOption} />
        </box>
      ) : (
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
      )}

      {/* Hint bar */}
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
        {isLoading ? (
          <PhaseIndicator
            phase={PHASE_LABELS[currentPhase]}
            startTime={loadingStartTime}
          />
        ) : showOptions ? (
          <text fg={colors.fg.muted}>j/k:navigate  Enter:select  Esc:quit</text>
        ) : (
          <text fg={colors.fg.muted}>Enter:send  Shift+Enter:newline  Ctrl+G:editor  Ctrl+W:del word  Esc:quit</text>
        )}
      </box>
    </box>
  );
}
