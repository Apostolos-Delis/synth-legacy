import { memo, type ReactNode } from "react";
import { colors } from "../theme.js";
import type { Toast as ToastType, ToastVariant } from "../hooks/useToast.js";

export type { ToastVariant } from "../hooks/useToast.js";

const VARIANT_ICONS: Record<ToastVariant, string> = {
  success: "\u2713",
  error: "\u2717",
  info: "\u2139",
  warning: "\u26A0",
};

function getVariantColor(variant: ToastVariant): string {
  switch (variant) {
    case "success": return colors.status.success;
    case "error": return colors.status.error;
    case "info": return colors.status.info;
    case "warning": return colors.status.warning;
  }
}

function ToastItem({ toast }: { toast: ToastType }): ReactNode {
  const icon = VARIANT_ICONS[toast.variant];
  const color = getVariantColor(toast.variant);

  return (
    <box
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 1,
        backgroundColor: colors.bg.highlight,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text fg={color}>{icon}</text>
      <text fg={colors.fg.primary}>{toast.message}</text>
    </box>
  );
}

export interface ToastContainerProps {
  toasts: ToastType[];
}

export const ToastContainer = memo(function ToastContainer({ toasts }: ToastContainerProps): ReactNode {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <box
      style={{
        flexDirection: "column",
        gap: 0,
        position: "absolute",
        bottom: 2,
        right: 1,
      }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </box>
  );
});
