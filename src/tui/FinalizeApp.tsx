import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";
import type { FinalizeMessage, FinalizePhase, ChatOption, CompletionSummary } from "../finalize/chat-types.js";
import type { FinalizeOrchestrator } from "../finalize/orchestrator.js";
import type { AgentAdapter } from "../agents/types.js";
import type { SynthConfig } from "../config/types.js";
import type { PlanPaths } from "../plans/types.js";
import { boldAttr, colors, markdownSyntaxStyle } from "./theme.js";
import { PhaseIndicator } from "./components/PhaseIndicator.js";
import { OptionSelector } from "./components/OptionSelector.js";
import { openInEditor } from "../utils/editor.js";
import { copyToClipboard } from "../utils/clipboard.js";
import { readText, fileExists } from "../utils/fs.js";
import { useDestroyedRef } from "./hooks/useDestroyedRef.js";
import { useSyncLineCount } from "./hooks/useSyncLineCount.js";
import { calcInputSizing } from "./hooks/useInputSizing.js";

interface FinalizeAppProps {
  orchestrator: FinalizeOrchestrator;
  agent: AgentAdapter;
  config: SynthConfig;
  planPaths: PlanPaths;
  cwd: string;
  onQuit: () => void;
  onComplete?: (summary: CompletionSummary) => void;
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
  const hasError = !!message.error;
  const roleColor = hasError
    ? colors.status.error
    : isUser ? colors.accent.primary : isSystem ? colors.status.info : colors.accent.secondary;
  const roleLabel = hasError ? "\u2717 Error" : isUser ? "You" : isSystem ? "System" : "Synth";

  if (hasError) {
    return (
      <box style={{ width: "100%", flexDirection: "column", marginBottom: 1, border: true, borderColor: colors.status.error, paddingLeft: 1, paddingRight: 1 }}>
        <box style={{ flexDirection: "row", gap: 1 }}>
          <text fg={roleColor} attributes={boldAttr()}>{roleLabel}</text>
          <text fg={colors.fg.muted}>[{message.error!.errorType}]</text>
        </box>
        <box style={{ paddingLeft: 2 }}>
          <markdown content={message.content} syntaxStyle={markdownSyntaxStyle()} />
        </box>
      </box>
    );
  }

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

export function FinalizeApp({ orchestrator, agent, config, planPaths, cwd, onQuit, onComplete }: FinalizeAppProps): ReactNode {
  const [messages, setMessages] = useState<FinalizeMessage[]>(() => orchestrator.getMessages());
  const [currentPhase, setCurrentPhase] = useState<FinalizePhase>(() => orchestrator.getCurrentPhase());
  const [isLoading, setIsLoading] = useState(true);
  const [streamingText, setStreamingText] = useState("");
  const [loadingStartTime, setLoadingStartTime] = useState(0);

  const textareaRef = useRef<TextareaRenderable>(null);
  const { height: termHeight } = useTerminalDimensions();
  const renderer = useRenderer();
  const editorOpenRef = useRef(false);

  const [completionSummary, setCompletionSummary] = useState<CompletionSummary | null>(null);
  const [prdContent, setPrdContent] = useState<string | null>(null);
  const completionFiredRef = useRef(false);

  const destroyedRef = useDestroyedRef();
  const { inputLineCount, setInputLineCount, syncLineCount } = useSyncLineCount(textareaRef, destroyedRef);

  // Subscribe to orchestrator phase changes and sync messages
  useEffect(() => {
    return orchestrator.onPhaseChange((phase) => {
      if (!destroyedRef.current) {
        setCurrentPhase(phase);
        setMessages([...orchestrator.getMessages()]);
      }
    });
  }, [orchestrator]);

  // Fetch completion summary and PRD content when phase becomes "complete"
  useEffect(() => {
    if (currentPhase !== "complete" || completionFiredRef.current) return;
    completionFiredRef.current = true;

    orchestrator.getCompletionSummary().then((summary) => {
      if (destroyedRef.current) return;
      setCompletionSummary(summary);
      onComplete?.(summary);
    });

    // Read PRD markdown for the completion screen
    fileExists(planPaths.prd).then((exists) => {
      if (!exists || destroyedRef.current) return;
      return readText(planPaths.prd);
    }).then((content) => {
      if (content && !destroyedRef.current) setPrdContent(content);
    }).catch(() => {
      // PRD file read is best-effort
    });
  }, [currentPhase, orchestrator, onComplete, planPaths.prd]);

  // Auto-start: trigger orchestrator.start() on mount
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    setIsLoading(true);
    setLoadingStartTime(Date.now());

    orchestrator.start(agent, config, planPaths, cwd, (chunk) => {
      if (!destroyedRef.current) setStreamingText((prev) => prev + chunk);
    }).then(() => {
      if (!destroyedRef.current) {
        setStreamingText("");
        setMessages([...orchestrator.getMessages()]);
        setIsLoading(false);
      }
    }).catch((err) => {
      if (!destroyedRef.current) {
        setStreamingText("");
        setMessages((prev) => [
          ...prev,
          { role: "system", content: `Audit error: ${err instanceof Error ? err.message : String(err)}` },
        ]);
        setIsLoading(false);
      }
    });
  }, [orchestrator, agent, config, planPaths, cwd]);

  // Execute fixes when phase transitions to "executing-fixes"
  const activeExecRef = useRef<string | null>(null);

  // Run PR creation as a standalone step (reused by both direct and chained paths)
  const runPrCreation = useCallback(() => {
    activeExecRef.current = "creating-pr";
    setIsLoading(true);
    setLoadingStartTime(Date.now());

    orchestrator.executePrCreation(config, planPaths, () => {
      if (!destroyedRef.current) setMessages([...orchestrator.getMessages()]);
    }).then(() => {
      activeExecRef.current = null;
      if (!destroyedRef.current) {
        setMessages([...orchestrator.getMessages()]);
        setIsLoading(false);
      }
    }).catch(() => {
      activeExecRef.current = null;
      if (!destroyedRef.current) setIsLoading(false);
    });
  }, [orchestrator, config, planPaths]);
  useEffect(() => {
    if (activeExecRef.current) return;

    if (currentPhase === "executing-fixes") {
      activeExecRef.current = "executing-fixes";
      setIsLoading(true);
      setLoadingStartTime(Date.now());

      orchestrator.executeFixes(agent, config, planPaths, () => {
        if (!destroyedRef.current) setMessages([...orchestrator.getMessages()]);
      }).then(() => {
        if (!destroyedRef.current) {
          setMessages([...orchestrator.getMessages()]);
          // Auto-chain into PR creation if fixes completed cleanly
          if (orchestrator.getCurrentPhase() === "creating-pr") {
            runPrCreation();
            return;
          }
        }
        activeExecRef.current = null;
        if (!destroyedRef.current) setIsLoading(false);
      }).catch(() => {
        activeExecRef.current = null;
        if (!destroyedRef.current) setIsLoading(false);
      });
    } else if (currentPhase === "creating-pr") {
      runPrCreation();
    }
  }, [currentPhase, orchestrator, agent, config, planPaths, runPrCreation]);

  // Determine if the last assistant message has options
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const isComplete = currentPhase === "complete";
  const optionGroups = lastMessage?.role === "assistant" && lastMessage.questionGroups?.length
    ? lastMessage.questionGroups
    : [];
  const showOptions = !isComplete && optionGroups.length > 0 && !isLoading;
  const optionSelectorHeight = showOptions
    ? Math.max(...optionGroups.map(g => g.options.length + 1)) * 2 + (optionGroups.length > 1 ? 2 : 0) + 2 + 4
    : 0;

  const handleOptionSelect = useCallback(async (selectedAnswers: ChatOption[]) => {
    if (isLoading) return;

    setIsLoading(true);
    setLoadingStartTime(Date.now());
    setStreamingText("");

    // For single-question, use the first answer directly
    // For multi-question, concatenate selections into a user message
    const option = selectedAnswers[0];
    const isMulti = selectedAnswers.length > 1;

    if (isMulti) {
      const summary = selectedAnswers.map((a, i) => `Q${i + 1}: ${a.label}`).join(", ");
      setMessages((prev) => [...prev, { role: "user", content: `Selected: ${summary}` }]);
    } else {
      setMessages((prev) => [...prev, { role: "user", content: `Selected: ${option.label}` }]);
    }

    try {
      if (isMulti) {
        // For multi-question, route each answer through handleOptionSelect for phase-aware handling,
        // then send a combined summary for the AI to respond to
        for (const answer of selectedAnswers) {
          await orchestrator.handleOptionSelect(answer, agent, (chunk) => {
            if (!destroyedRef.current) setStreamingText((prev) => prev + chunk);
          });
        }
      } else {
        await orchestrator.handleOptionSelect(option, agent, (chunk) => {
          if (!destroyedRef.current) setStreamingText((prev) => prev + chunk);
        });
      }

      if (!destroyedRef.current) {
        setStreamingText("");
        setMessages(orchestrator.getMessages());
        setIsLoading(false);
      }
    } catch (err) {
      if (!destroyedRef.current) {
        setStreamingText("");
        setMessages((prev) => [
          ...prev,
          { role: "system", content: `Error: ${err instanceof Error ? err.message : "Agent failed to respond"}` },
        ]);
        setIsLoading(false);
      }
    }
  }, [isLoading, orchestrator, agent]);

  const handleSubmit = useCallback(async () => {
    if (isLoading || showOptions) return;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const value = (textarea.plainText ?? "").trim();
    if (!value) return;

    textarea.editBuffer.setText("");
    setInputLineCount(1);

    // Immediately show the user message
    setMessages((prev) => [...prev, { role: "user", content: value }]);
    setIsLoading(true);
    setLoadingStartTime(Date.now());
    setStreamingText("");

    try {
      await orchestrator.handleUserMessage(value, agent, (chunk) => {
        if (!destroyedRef.current) setStreamingText((prev) => prev + chunk);
      });

      if (!destroyedRef.current) {
        setStreamingText("");
        setMessages(orchestrator.getMessages());
        setIsLoading(false);
      }
    } catch (err) {
      if (!destroyedRef.current) {
        setStreamingText("");
        setMessages((prev) => [
          ...prev,
          { role: "system", content: `Error: ${err instanceof Error ? err.message : "Agent failed to respond"}` },
        ]);
        setIsLoading(false);
      }
    }
  }, [isLoading, showOptions, orchestrator, agent]);

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
      if (isComplete) {
        key.preventDefault?.();
        onQuit();
        return;
      }
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
  }, [handleSubmit, onQuit, isLoading, isComplete, showOptions, syncLineCount, renderer, messages]));

  const { inputHeight, textareaHeight } = calcInputSizing(termHeight, inputLineCount);

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
                {!streamingText && (
                  <PhaseIndicator
                    phase={PHASE_LABELS[currentPhase]}
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
          {isComplete && completionSummary && (
            <box style={{ width: "100%", flexDirection: "column", marginBottom: 1 }}>
              <box style={{ flexDirection: "row", gap: 1, marginBottom: 1 }}>
                <text fg={colors.status.success} attributes={boldAttr()}>{"\u2713"} Finalize Complete</text>
              </box>
              {completionSummary.prUrl && (
                <box style={{ paddingLeft: 2, marginBottom: 1 }}>
                  <text fg={colors.fg.muted}>PR  </text>
                  <text fg={colors.accent.primary} attributes={boldAttr()}>{completionSummary.prUrl}</text>
                </box>
              )}
              {prdContent && (
                <box style={{ paddingLeft: 2, flexDirection: "column" }}>
                  <markdown content={prdContent} syntaxStyle={markdownSyntaxStyle()} />
                </box>
              )}
            </box>
          )}
        </scrollbox>
      </box>

      {/* Input area */}
      {isComplete ? (
        <box
          style={{
            width: "100%",
            height: 3,
            flexDirection: "column",
            backgroundColor: colors.bg.secondary,
            border: true,
            borderColor: colors.status.success,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <text fg={colors.fg.muted}>Press Enter or Ctrl+C to exit</text>
        </box>
      ) : showOptions ? (
        <box
          style={{
            width: "100%",
            height: optionSelectorHeight,
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
          <OptionSelector groups={optionGroups} onSelect={handleOptionSelect} />
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
        {isComplete ? (
          <text fg={colors.status.success}>Finalization complete</text>
        ) : isLoading ? (
          <PhaseIndicator
            phase={streamingText ? "Streaming response..." : PHASE_LABELS[currentPhase]}
            startTime={loadingStartTime}
          />
        ) : showOptions ? (
          <text fg={colors.fg.muted}>Esc:quit</text>
        ) : (
          <text fg={colors.fg.muted}>Enter:send  Shift+Enter:newline  Ctrl+G:editor  Ctrl+W:del word  Esc:quit</text>
        )}
      </box>
    </box>
  );
}
