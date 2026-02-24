import { useState, useCallback, useRef, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import type { SelectRenderable, SelectOption, TextareaRenderable } from "@opentui/core";
import type { ChatOption, QuestionGroup } from "../../finalize/chat-types.js";
import { boldAttr, colors } from "../theme.js";

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

function toSelectOptions(options: ChatOption[], showOther: boolean): SelectOption[] {
  const mapped: SelectOption[] = options.map((o) => ({
    name: o.label + (o.recommended ? " (Recommended)" : ""),
    description: o.description,
    value: o.value,
  }));
  if (showOther) {
    mapped.push({ name: OTHER_OPTION.label, description: OTHER_OPTION.description, value: OTHER_OPTION.value });
  }
  return mapped;
}

export function OptionSelector({ groups, onSelect, showOther = true }: OptionSelectorProps): ReactNode {
  const [activeTab, setActiveTab] = useState(0);
  const [selectedIndices, setSelectedIndices] = useState<number[]>(() =>
    groups.map((g) => {
      const rec = g.options.findIndex((o) => o.recommended);
      return rec >= 0 ? rec : 0;
    }),
  );
  const [mode, setMode] = useState<Mode>("selecting");
  const [answers, setAnswers] = useState<(ChatOption | null)[]>(() => groups.map(() => null));

  const selectRef = useRef<SelectRenderable>(null);
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

  const currentGroup = groups[activeTab];
  const allOptions = showOther ? [...currentGroup.options, OTHER_OPTION] : currentGroup.options;
  const selectOptions = toSelectOptions(currentGroup.options, showOther);
  const isMultiQuestion = groups.length > 1;

  // The native <select> computes maxVisibleItems = floor(height / linesPerItem).
  // With showDescription + itemSpacing=0, linesPerItem=2. Give it exactly N*2 so all items are visible.
  const selectHeight = selectOptions.length * 2;

  const trySubmit = useCallback((updatedAnswers: (ChatOption | null)[]) => {
    const allAnswered = updatedAnswers.every((a) => a !== null);
    if (allAnswered) {
      onSelectRef.current(updatedAnswers as ChatOption[]);
    }
  }, []);

  const handleSelect = useCallback((_index: number, option: SelectOption | null) => {
    if (!option) return;
    const tab = activeTabRef.current;
    const g = groupsRef.current;

    if (option.value === "__other__") {
      setMode("typing-other");
      return;
    }

    // Find the matching ChatOption
    const chatOption = g[tab].options.find((o) => o.value === option.value);
    if (!chatOption) return;

    const newAnswers = [...answersRef.current];
    newAnswers[tab] = chatOption;
    setAnswers(newAnswers);

    if (g.length > 1 && tab < g.length - 1) {
      setActiveTab(tab + 1);
    } else {
      trySubmit(newAnswers);
    }
  }, [trySubmit]);

  const handleChange = useCallback((index: number, _option: SelectOption | null) => {
    const tab = activeTabRef.current;
    setSelectedIndices((prev) => {
      const next = [...prev];
      next[tab] = index;
      return next;
    });
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
          key.preventDefault?.();
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
        return;
      }

      // -- selecting mode: supplementary keys --
      // Note: arrow keys (up/down/j/k) are handled by the native <select> via
      // handleKeyPress — do NOT intercept them here or the select won't navigate.

      // Number keys 1-9 to jump to option
      const numKey = parseInt(key.name, 10);
      if (!isNaN(numKey) && numKey >= 1 && numKey <= count) {
        key.preventDefault?.();
        const idx = numKey - 1;
        selectRef.current?.setSelectedIndex(idx);
        setSelectedIndices((prev) => {
          const next = [...prev];
          next[tab] = idx;
          return next;
        });
        return;
      }

      // Enter — explicitly select the focused option (don't rely on native <select>)
      if (key.name === "return" && !key.shift && !key.ctrl && !key.meta) {
        key.preventDefault?.();
        const idx = selectedIndicesRef.current[tab] ?? 0;
        const selectOpts = toSelectOptions(current.options, showOtherRef.current);
        handleSelect(idx, selectOpts[idx] ?? null);
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

      {/* Native select for options */}
      {mode === "selecting" && (
        <select
          ref={selectRef}
          options={selectOptions}
          selectedIndex={selectedIndices[activeTab] ?? 0}
          focused={true}
          showDescription={true}
          wrapSelection={true}
          textColor={colors.fg.secondary}
          descriptionColor={colors.fg.muted}
          selectedTextColor={colors.accent.primary}
          selectedDescriptionColor={colors.fg.secondary}
          onSelect={handleSelect}
          onChange={handleChange}
          style={{ height: selectHeight }}
        />
      )}

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
        <box>
          <text fg={colors.fg.dim}>
            {"\u2191/\u2193:navigate  Enter:select  1-" + allOptions.length + ":jump"}
            {isMultiQuestion ? "  Tab:next question" : ""}
          </text>
        </box>
      )}
    </box>
  );
}
