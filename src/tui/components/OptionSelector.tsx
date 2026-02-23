import { useState, useCallback, useRef, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import type { ChatOption } from "../../finalize/chat-types.js";
import { colors } from "../theme.js";

export interface OptionSelectorProps {
  options: ChatOption[];
  onSelect: (option: ChatOption) => void;
  prompt?: string;
}

export function OptionSelector({ options, onSelect, prompt }: OptionSelectorProps): ReactNode {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useKeyboard(
    useCallback((key: { name: string }) => {
      const count = optionsRef.current.length;
      if (count === 0) return;

      if (key.name === "j" || key.name === "down") {
        setSelectedIndex((i) => Math.min(i + 1, count - 1));
        return;
      }
      if (key.name === "k" || key.name === "up") {
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (key.name === "return") {
        onSelectRef.current(optionsRef.current[selectedIndexRef.current]);
      }
    }, []),
  );

  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      {prompt && (
        <box style={{ marginBottom: 1 }}>
          <text fg={colors.fg.primary}>{prompt}</text>
        </box>
      )}
      {options.map((option, i) => {
        const isSelected = i === selectedIndex;
        return (
          <box key={option.value} style={{ flexDirection: "row", paddingLeft: 1 }}>
            <text fg={isSelected ? colors.accent.primary : colors.fg.dim}>
              {isSelected ? "▸ " : "  "}
            </text>
            <box style={{ flexDirection: "column" }}>
              <text fg={isSelected ? colors.accent.primary : colors.fg.primary}>
                {option.label}
              </text>
              <text fg={isSelected ? colors.fg.secondary : colors.fg.muted}>
                {option.description}
              </text>
            </box>
          </box>
        );
      })}
      <box style={{ marginTop: 1 }}>
        <text fg={colors.fg.muted}>j/k:navigate  Enter:select</text>
      </box>
    </box>
  );
}
