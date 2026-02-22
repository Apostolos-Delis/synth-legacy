export const colors = {
  primary: "\x1b[36m",    // cyan
  success: "\x1b[32m",    // green
  warning: "\x1b[33m",    // yellow
  error: "\x1b[31m",      // red
  muted: "\x1b[90m",      // gray
  bold: "\x1b[1m",
  reset: "\x1b[0m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
};

export const STATUS_ICONS: Record<string, string> = {
  open: "○",
  in_progress: "◐",
  done: "✓",
  failed: "✗",
  skipped: "⊘",
};

export const STATUS_COLORS: Record<string, string> = {
  open: colors.muted,
  in_progress: colors.primary,
  done: colors.success,
  failed: colors.error,
  skipped: colors.muted,
};

export const PRIORITY_COLORS: Record<number, string> = {
  1: colors.error,
  2: colors.warning,
  3: colors.primary,
  4: colors.muted,
  5: colors.muted,
};
