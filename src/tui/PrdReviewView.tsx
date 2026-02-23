import { useState, useCallback, useRef, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";
import type { AgentAdapter } from "../agents/types.js";
import { boldAttr, colors, markdownSyntaxStyle } from "./theme.js";
import { PhaseIndicator } from "./components/PhaseIndicator.js";
import { OptionSelector } from "./components/OptionSelector.js";
import { ToastContainer } from "./components/Toast.js";
import { useToast } from "./hooks/useToast.js";
import type { ChatOption, QuestionGroup } from "../finalize/chat-types.js";
import { openInEditor } from "../utils/editor.js";
import { useDestroyedRef } from "./hooks/useDestroyedRef.js";
import { useSyncLineCount } from "./hooks/useSyncLineCount.js";
import { calcInputSizing } from "./hooks/useInputSizing.js";

interface PrdReviewViewProps {
  prdMarkdown: string;
  agent: AgentAdapter;
  cwd: string;
  model?: string;
  onApprove: (finalizedPrd: string) => void;
  onQuit: () => void;
}

const REVIEW_OPTIONS: ChatOption[] = [
  { label: "Execute Session", description: "Approve the PRD and proceed to task generation", value: "approve" },
  { label: "Request Changes", description: "Type follow-up feedback to revise the PRD", value: "revise" },
];

const REVIEW_GROUPS: QuestionGroup[] = [{ question: "", options: REVIEW_OPTIONS }];

export function PrdReviewView({
  prdMarkdown,
  agent,
  cwd,
  model,
  onApprove,
  onQuit,
}: PrdReviewViewProps): ReactNode {
  const [prdContent, setPrdContent] = useState(prdMarkdown);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStartTime, setLoadingStartTime] = useState(0);
  const [streamingText, setStreamingText] = useState("");
  const [showTextInput, setShowTextInput] = useState(false);
  const [revision, setRevision] = useState(0);
  const textareaRef = useRef<TextareaRenderable>(null);
  const { height: termHeight } = useTerminalDimensions();
  const renderer = useRenderer();
  const editorOpenRef = useRef(false);

  const { toasts, showError } = useToast();
  const destroyedRef = useDestroyedRef();
  const { inputLineCount, setInputLineCount, syncLineCount } = useSyncLineCount(textareaRef, destroyedRef);

  const handleOptionSelect = useCallback(async (selectedAnswers: ChatOption[]) => {
    const option = selectedAnswers[0];
    if (option.value === "approve") {
      onApprove(prdContent);
    } else if (option.value === "revise") {
      setShowTextInput(true);
    }
  }, [prdContent, onApprove]);

  const handleSubmit = useCallback(async () => {
    if (isLoading) return;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const value = (textarea.plainText ?? "").trim();
    if (!value) {
      // Empty input goes back to option selector
      setShowTextInput(false);
      return;
    }

    textarea.editBuffer.setText("");
    setInputLineCount(1);
    setIsLoading(true);
    const startTime = Date.now();
    setLoadingStartTime(startTime);
    setStreamingText("");

    const prompt = buildRevisionPrompt(prdContent, value);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let output = "";
        if (attempt > 0 && !destroyedRef.current) setStreamingText("");
        const handle = agent.execute(prompt, {
          cwd,
          model,
          skipPermissions: false,
          onStdout: (chunk) => {
            output += chunk;
            if (!destroyedRef.current) setStreamingText((prev) => prev + chunk);
          },
        });
        const result = await handle.promise;
        if (result.timedOut) {
          throw new Error("PRD revision agent timed out");
        }
        if (result.exitCode !== 0) {
          throw new Error(`PRD revision agent exited with code ${result.exitCode}: ${result.stderr}`);
        }

        if (!destroyedRef.current) {
          const revisedPrd = extractMarkdownPrd(output) || output;
          setPrdContent(revisedPrd);
          setRevision((r) => r + 1);
          setStreamingText("");
          setIsLoading(false);
          setShowTextInput(false);
        }
        return;
      } catch (err) {
        // Don't retry if the component was unmounted or user cancelled
        if (destroyedRef.current) return;
        if (err instanceof Error && (err.name === "AbortError" || err.message.includes("cancel"))) {
          setStreamingText("");
          setIsLoading(false);
          return;
        }
        // Auto-retry on first attempt; show toast after final failure
      }
    }

    if (!destroyedRef.current) {
      showError("Revision failed — try again or edit manually", { duration: 5000 });
      setStreamingText("");
      setIsLoading(false);
    }
  }, [isLoading, prdContent, agent, cwd, model, showError]);

  useKeyboard(useCallback((key: { name: string; shift?: boolean; ctrl?: boolean; meta?: boolean; option?: boolean; preventDefault?: () => void }) => {
    const textarea = textareaRef.current;

    // Shift+Enter or Ctrl+J for newline
    if (
      (key.name === "return" && (key.shift || key.meta)) ||
      key.name === "linefeed" ||
      (key.name === "j" && key.ctrl)
    ) {
      if (!showTextInput) return;
      key.preventDefault?.();
      textarea?.newLine();
      return;
    }

    // Enter to send (bare, unmodified) — only in text input mode
    if (key.name === "return" && !key.shift && !key.ctrl && !key.meta) {
      if (!showTextInput) return; // OptionSelector handles its own Enter
      key.preventDefault?.();
      handleSubmit();
      return;
    }

    // Escape or Ctrl+C to quit
    if (key.name === "escape") {
      if (showTextInput && !isLoading) {
        setShowTextInput(false);
        return;
      }
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
      if (!textarea || isLoading || editorOpenRef.current || !showTextInput) return;
      editorOpenRef.current = true;
      const currentText = textarea.plainText ?? "";
      renderer.suspend();
      openInEditor(currentText)
        .then((result) => {
          if (result !== null && !destroyedRef.current) {
            textarea.editBuffer.setText(result);
            syncLineCount();
          }
        })
        .catch(() => {})
        .finally(() => {
          renderer.resume();
          editorOpenRef.current = false;
        });
      return;
    }

    // Text editing shortcuts (only in text input mode)
    if (!textarea || isLoading || !showTextInput) return;

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
  }, [handleSubmit, onQuit, isLoading, showTextInput, syncLineCount, renderer]));

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
          <text fg={colors.accent.primary} attributes={boldAttr()}>synth session</text>
          <text fg={colors.fg.muted}>PRD Review</text>
        </box>
        <text fg={colors.fg.muted}>
          {revision > 0 ? `revision ${revision}` : "initial"}
        </text>
      </box>

      {/* PRD content area */}
      <box
        style={{
          flexGrow: 1,
          flexDirection: "column",
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
        }}
      >
        <scrollbox style={{ flexGrow: 1 }} stickyScroll={true} stickyStart="top">
          {isLoading && streamingText ? (
            <box style={{ paddingLeft: 2 }}>
              <markdown content={streamingText} syntaxStyle={markdownSyntaxStyle()} streaming={true} />
            </box>
          ) : (
            <markdown content={prdContent} syntaxStyle={markdownSyntaxStyle()} />
          )}
        </scrollbox>
      </box>

      {/* Input area */}
      {isLoading && !streamingText ? (
        <box
          style={{
            width: "100%",
            height: 3,
            flexDirection: "column",
            backgroundColor: colors.bg.secondary,
            border: true,
            borderColor: colors.border.normal,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <PhaseIndicator phase="Revising PRD..." startTime={loadingStartTime} />
        </box>
      ) : isLoading && streamingText ? (
        <box
          style={{
            width: "100%",
            height: 3,
            flexDirection: "column",
            backgroundColor: colors.bg.secondary,
            border: true,
            borderColor: colors.border.normal,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <PhaseIndicator phase="Streaming revision..." startTime={loadingStartTime} />
        </box>
      ) : showTextInput ? (
        <box
          style={{
            width: "100%",
            height: inputHeight,
            flexDirection: "column",
            backgroundColor: colors.bg.secondary,
            border: true,
            borderColor: colors.border.active,
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
              placeholder="Describe what changes you'd like to the PRD..."
              focused={true}
            />
          </box>
        </box>
      ) : (
        <box
          style={{
            width: "100%",
            height: REVIEW_OPTIONS.length * 2 + 2 + 4,
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
          <OptionSelector groups={REVIEW_GROUPS} onSelect={handleOptionSelect} showOther={false} />
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
          <text fg={colors.fg.muted}>Esc:cancel</text>
        ) : showTextInput ? (
          <text fg={colors.fg.muted}>Enter:send  Shift+Enter:newline  Ctrl+G:editor  Esc:back</text>
        ) : (
          <text fg={colors.fg.muted}>j/k:navigate  Enter:select  Esc:quit</text>
        )}
      </box>

      <ToastContainer toasts={toasts} />
    </box>
  );
}

function buildRevisionPrompt(currentPrd: string, feedback: string): string {
  return `You are revising a Product Requirements Document (PRD) based on user feedback.

Here is the current PRD:

${currentPrd}

The user has requested the following changes:

${feedback}

Please output the complete revised PRD in markdown format. Wrap the entire revised PRD in a markdown code block with the \`markdown\` language tag:

\`\`\`markdown
(revised PRD here)
\`\`\`

Only output the revised PRD in the code block. Do not include any other text.`;
}

function extractMarkdownPrd(output: string): string | null {
  const match = output.match(/```markdown\s*([\s\S]*?)\s*```/);
  return match ? match[1].trim() : null;
}
