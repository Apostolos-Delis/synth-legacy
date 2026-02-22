import type { ReactNode } from "react";
import { colors } from "../theme.js";

export interface ConfirmationDialogProps {
  visible: boolean;
  title: string;
  message: string;
  hint?: string;
}

export function ConfirmationDialog({
  visible,
  title,
  message,
  hint = "[y] Yes  [n/Esc] No",
}: ConfirmationDialogProps): ReactNode {
  if (!visible) {
    return null;
  }

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <box
        style={{
          width: 50,
          height: 9,
          backgroundColor: colors.bg.secondary,
          border: true,
          borderColor: colors.status.warning,
          flexDirection: "column",
          padding: 1,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <text fg={colors.status.warning}>{title}</text>
        <box style={{ height: 1 }} />
        <text fg={colors.fg.primary}>{message}</text>
        <box style={{ height: 1 }} />
        <text fg={colors.fg.muted}>{hint}</text>
      </box>
    </box>
  );
}
