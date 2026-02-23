import { useState, useCallback, useRef, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";
import type { ChatOption, QuestionGroup } from "../../finalize/chat-types.js";
import { boldAttr, colors } from "../theme.js";

function wordWrap(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  if (text.length <= maxWidth) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxWidth) {
      lines.push(remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf(" ", maxWidth);
    if (breakAt <= 0) breakAt = maxWidth;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  return lines;
}

export interface OptionSelectorProps {
  groups: QuestionGroup[];
  onSelect: (answers: ChatOption[]) => void;
  showOther?: boolean;
}

type Mode = "selecting" | "typing-other";

const OTHER_OPTION: ChatOption = {
  label: "Other...",
  description: "Type a custom response",
  value: "__other__",
};

export function OptionSelector({ groups, onSelect, showOther = true }: OptionSelectorProps): ReactNode {
  const [activeTab, setActiveTab] = useState(0);
  const [selectedIndices, setSelectedIndices] = useState<(number | null)[]>(() =>
    groups.map((g) => {
      const rec = g.options.findIndex((o) => o.recommended);
      return rec >= 0 ? rec : null;
    }),
  );
  const [mode, setMode] = useState<Mode>("selecting");
  const [answers, setAnswers] = useState<(ChatOption | null)[]>(() => groups.map(() => null));

  const textareaRef = useRef<TextareaRenderable>(null);

  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const selectedIndicesRef = useRef(selectedIndices);
  selectedIndicesRef.current = selectedIndices;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const showOtherRef = useRef(showOther);
  showOtherRef.current = showOther;

  const { width: termWidth } = useTerminalDimensions();

  const currentGroup = groups[activeTab];
  const optionsWithOther = showOther
    ? [...currentGroup.options, OTHER_OPTION]
    : currentGroup.options;
  const selectedIndex = selectedIndices[activeTab] ?? 0;
  const isMultiQuestion = groups.length > 1;

  // Prefix is: paddingLeft(1) + radio(1) + space(1) + num(1-2) + "." + space = ~6-7 chars
  const labelPrefixWidth = 6;
  const labelAvail = Math.max(20, termWidth - 1 - labelPrefixWidth);
  const descAvail = Math.max(20, termWidth - 1 - 5); // paddingLeft(1) + inner paddingLeft(5)

  const trySubmit = useCallback((updatedAnswers: (ChatOption | null)[]) => {
    const allAnswered = updatedAnswers.every((a) => a !== null);
    if (allAnswered) {
      onSelectRef.current(updatedAnswers as ChatOption[]);
    }
  }, []);

  useKeyboard(
    useCallback((key: { name: string; shift?: boolean; ctrl?: boolean; meta?: boolean; sequence?: string; preventDefault?: () => void }) => {
      const g = groupsRef.current;
      const tab = activeTabRef.current;
      const current = g[tab];
      if (!current) return;

      const opts = showOtherRef.current
        ? [...current.options, OTHER_OPTION]
        : current.options;
      const count = opts.length;

      // -- typing-other mode --
      if (modeRef.current === "typing-other") {
        if (key.name === "escape") {
          setMode("selecting");
          return;
        }
        if (key.name === "return" && !key.shift) {
          const text = (textareaRef.current?.plainText ?? "").trim();
          if (!text) return;
          const customOption: ChatOption = {
            label: text,
            description: "Custom response",
            value: "__other__",
          };
          const newAnswers = [...answersRef.current];
          newAnswers[tab] = customOption;
          setAnswers(newAnswers);
          setMode("selecting");

          if (g.length > 1 && tab < g.length - 1) {
            setActiveTab(tab + 1);
          } else {
            trySubmit(newAnswers);
          }
          return;
        }
        // Let the textarea handle all other keys
        return;
      }

      // -- selecting mode --
      if (key.name === "j" || key.name === "down") {
        setSelectedIndices((prev) => {
          const next = [...prev];
          next[tab] = Math.min((next[tab] ?? 0) + 1, count - 1);
          return next;
        });
        return;
      }
      if (key.name === "k" || key.name === "up") {
        setSelectedIndices((prev) => {
          const next = [...prev];
          next[tab] = Math.max((next[tab] ?? 0) - 1, 0);
          return next;
        });
        return;
      }

      // Number keys 1-9 to jump to option
      const numKey = parseInt(key.name, 10);
      if (!isNaN(numKey) && numKey >= 1 && numKey <= count) {
        setSelectedIndices((prev) => {
          const next = [...prev];
          next[tab] = numKey - 1;
          return next;
        });
        return;
      }

      // Tab / Shift+Tab for multi-question navigation
      if (key.name === "tab" && g.length > 1) {
        key.preventDefault?.();
        if (key.shift) {
          setActiveTab((prev) => (prev > 0 ? prev - 1 : g.length - 1));
        } else {
          setActiveTab((prev) => (prev < g.length - 1 ? prev + 1 : 0));
        }
        return;
      }

      // Enter to select
      if (key.name === "return") {
        const idx = selectedIndicesRef.current[tab] ?? 0;
        const selected = opts[idx];
        if (!selected) return;

        if (selected.value === "__other__") {
          setMode("typing-other");
          return;
        }

        const newAnswers = [...answersRef.current];
        newAnswers[tab] = selected;
        setAnswers(newAnswers);

        if (g.length > 1 && tab < g.length - 1) {
          // Move to next unanswered tab
          setActiveTab(tab + 1);
        } else {
          trySubmit(newAnswers);
        }
      }
    }, [trySubmit]),
  );

  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      {/* Tab bar for multi-question */}
      {isMultiQuestion && (
        <box style={{ flexDirection: "row", gap: 2, marginBottom: 1 }}>
          {groups.map((g, i) => {
            const isActive = i === activeTab;
            const isAnswered = answers[i] !== null;
            const prefix = isAnswered ? "\u2713 " : "";
            const label = g.question || `Q${i + 1}`;
            return (
              <text
                key={i}
                fg={isActive ? colors.accent.primary : isAnswered ? colors.status.success : colors.fg.muted}
                attributes={isActive ? boldAttr() : undefined}
              >
                {prefix}{label}{isActive ? " \u25C0" : ""}
              </text>
            );
          })}
        </box>
      )}

      {/* Question header */}
      {currentGroup.question && (
        <box style={{ marginBottom: 1 }}>
          <text fg={colors.fg.primary} attributes={boldAttr()}>{currentGroup.question}</text>
        </box>
      )}

      {/* Options list */}
      {mode === "selecting" && optionsWithOther.map((option, i) => {
        const isSelected = i === selectedIndex;
        const isOther = option.value === "__other__";
        const num = `${i + 1}`;
        const radio = isSelected ? "\u25CF" : "\u25CB";
        const recommendedBadge = option.recommended ? " (Recommended)" : "";
        const fullLabel = option.label + recommendedBadge;
        const labelLines = wordWrap(fullLabel, labelAvail);
        const descLines = option.description ? wordWrap(option.description, descAvail) : [];

        return (
          <box key={option.value + i} style={{ flexDirection: "column", paddingLeft: 1, marginBottom: 0 }}>
            <box style={{ flexDirection: "row" }}>
              <text fg={isSelected ? colors.accent.primary : colors.fg.dim}>
                {radio} {num}.{" "}
              </text>
              <text
                fg={isSelected ? colors.accent.primary : colors.fg.primary}
                attributes={isSelected ? boldAttr() : undefined}
              >
                {labelLines[0]}
              </text>
            </box>
            {labelLines.slice(1).map((line, li) => (
              <box key={`label-${li}`} style={{ paddingLeft: labelPrefixWidth }}>
                <text
                  fg={isSelected ? colors.accent.primary : colors.fg.primary}
                  attributes={isSelected ? boldAttr() : undefined}
                >
                  {line}
                </text>
              </box>
            ))}
            {descLines.map((line, di) => (
              <box key={`desc-${di}`} style={{ paddingLeft: 5 }}>
                <text fg={isOther ? colors.fg.muted : isSelected ? colors.fg.secondary : colors.fg.muted}>
                  {line}
                </text>
              </box>
            ))}
          </box>
        );
      })}

      {/* Other text input mode */}
      {mode === "typing-other" && (
        <box style={{ flexDirection: "column", paddingLeft: 1 }}>
          <box style={{ marginBottom: 1 }}>
            <text fg={colors.accent.primary} attributes={boldAttr()}>Custom response:</text>
          </box>
          <box style={{ flexDirection: "row", height: 3 }}>
            <text fg={colors.accent.primary}>{"> "}</text>
            <textarea
              ref={textareaRef}
              style={{ flexGrow: 1, height: 3 }}
              placeholder="Type your response..."
              focused={true}
            />
          </box>
          <box style={{ marginTop: 1 }}>
            <text fg={colors.fg.muted}>Enter:submit  Esc:back</text>
          </box>
        </box>
      )}

      {/* Hint bar */}
      {mode === "selecting" && (
        <box style={{ marginTop: 1 }}>
          <text fg={colors.fg.muted}>
            {"j/k:navigate  Enter:select"}
            {isMultiQuestion ? "  Tab:next question" : ""}
          </text>
        </box>
      )}
    </box>
  );
}
