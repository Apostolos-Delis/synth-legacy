import { memo, useMemo, type ReactNode } from "react";
import { colors, fullKeyboardShortcuts } from "../theme.js";

export interface HelpOverlayProps {
  visible: boolean;
}

function groupShortcutsByCategory(): Map<string, Array<{ key: string; description: string }>> {
  const groups = new Map<string, Array<{ key: string; description: string }>>();

  for (const shortcut of fullKeyboardShortcuts) {
    const existing = groups.get(shortcut.category) || [];
    existing.push({ key: shortcut.key, description: shortcut.description });
    groups.set(shortcut.category, existing);
  }

  return groups;
}

// Pre-compute static shortcut data once at module level
const shortcutGroups = groupShortcutsByCategory();
const maxKeyWidth = fullKeyboardShortcuts.reduce((max, s) => Math.max(max, s.key.length), 0);

export const HelpOverlay = memo(function HelpOverlay({ visible }: HelpOverlayProps): ReactNode {
  // Pre-render content once and cache — only the outer wrapper visibility changes
  const content = useMemo(
    () => (
      <box
        style={{
          flexDirection: "column",
          padding: 2,
          backgroundColor: colors.bg.secondary,
          borderColor: colors.accent.primary,
          minWidth: 50,
          maxWidth: 60,
        }}
        border
      >
        <box style={{ marginBottom: 1, justifyContent: "center" }}>
          <text fg={colors.accent.primary}>Keyboard Shortcuts</text>
        </box>

        {Array.from(shortcutGroups.entries()).map(([category, shortcuts]) => (
          <box key={category} style={{ flexDirection: "column", marginBottom: 1 }}>
            <text fg={colors.fg.muted}>{category}</text>

            {shortcuts.map((shortcut) => (
              <box key={shortcut.key} style={{ flexDirection: "row" }}>
                <text fg={colors.status.info}>
                  {shortcut.key.padEnd(maxKeyWidth + 2)}
                </text>
                <text fg={colors.fg.primary}>{shortcut.description}</text>
              </box>
            ))}
          </box>
        ))}

        <box style={{ marginTop: 1, justifyContent: "center" }}>
          <text fg={colors.fg.muted}>Press ? or Esc to close</text>
        </box>
      </box>
    ),
    [],
  );

  if (!visible) {
    return null;
  }

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#000000B3",
      }}
    >
      {content}
    </box>
  );
});
