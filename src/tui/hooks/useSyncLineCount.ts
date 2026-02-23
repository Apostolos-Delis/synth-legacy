import { useState, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";

/**
 * Tracks the number of lines in a textarea and keeps it in sync after every keystroke.
 * Returns the line count state, its setter (for manual resets), and the sync callback.
 */
export function useSyncLineCount(
  textareaRef: React.RefObject<TextareaRenderable | null>,
  destroyedRef: React.RefObject<boolean>,
) {
  const [inputLineCount, setInputLineCount] = useState(1);

  const syncLineCount = useCallback(() => {
    if (destroyedRef.current) return;
    try {
      const text = textareaRef.current?.plainText ?? "";
      setInputLineCount(Math.max(1, text.split("\n").length));
    } catch {
      // EditBuffer may be destroyed during shutdown
    }
  }, [destroyedRef, textareaRef]);

  // Sync line count after every key event (runs after textarea processes the key)
  useKeyboard(useCallback(() => {
    setTimeout(syncLineCount, 0);
  }, [syncLineCount]));

  return { inputLineCount, setInputLineCount, syncLineCount };
}
