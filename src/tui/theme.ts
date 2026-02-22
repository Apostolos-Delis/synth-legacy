// Hex color theme for TUI components (used with <span fg={}>)
export interface ThemeColors {
  bg: { primary: string; secondary: string; highlight: string };
  fg: { primary: string; secondary: string; muted: string; dim: string };
  status: { success: string; warning: string; error: string; info: string };
  accent: { primary: string; secondary: string };
  border: { normal: string; active: string; muted: string };
}

export const colors: ThemeColors = {
  bg: { primary: "#1a1b26", secondary: "#24283b", highlight: "#292e42" },
  fg: { primary: "#c0caf5", secondary: "#a9b1d6", muted: "#565f89", dim: "#3b4261" },
  status: { success: "#9ece6a", warning: "#e0af68", error: "#f7768e", info: "#7dcfff" },
  accent: { primary: "#7aa2f7", secondary: "#bb9af7" },
  border: { normal: "#3b4261", active: "#7aa2f7", muted: "#292e42" },
};

function rebuildDerivedMaps(): void {
  STATUS_COLORS_HEX.open = colors.fg.muted;
  STATUS_COLORS_HEX.in_progress = colors.status.info;
  STATUS_COLORS_HEX.done = colors.status.success;
  STATUS_COLORS_HEX.failed = colors.status.error;
  STATUS_COLORS_HEX.skipped = colors.fg.muted;

  PRIORITY_COLORS_HEX[1] = colors.status.error;
  PRIORITY_COLORS_HEX[2] = colors.status.warning;
  PRIORITY_COLORS_HEX[3] = colors.status.info;
  PRIORITY_COLORS_HEX[4] = colors.fg.muted;
  PRIORITY_COLORS_HEX[5] = colors.fg.muted;
}

export function initTheme(theme: ThemeColors, spinnerFrames: string[]): void {
  Object.assign(colors.bg, theme.bg);
  Object.assign(colors.fg, theme.fg);
  Object.assign(colors.status, theme.status);
  Object.assign(colors.accent, theme.accent);
  Object.assign(colors.border, theme.border);

  SPINNER_FRAMES.length = 0;
  SPINNER_FRAMES.push(...spinnerFrames);

  rebuildDerivedMaps();
}

export const statusIndicators: Record<string, string> = {
  open: "\u25CB",
  in_progress: "\u25D0",
  done: "\u2713",
  failed: "\u2717",
  skipped: "\u2298",
  executing: "\u25B6",
  paused: "\u23F8",
  completed: "\u2713",
  idle: "\u25CB",
  blocked: "\u2298",
};

export const layout = {
  header: { height: 1 },
  footer: { height: 1 },
  sidebar: { minWidth: 30, maxWidth: 50, defaultWidthPercent: 30 },
  padding: { small: 1, medium: 2 },
};

export const SPINNER_FRAMES: string[] = ["\u280B","\u2819","\u2839","\u2838","\u283C","\u2834","\u2826","\u2827","\u2807","\u280F"];

// Status colors for TUI components (hex)
export const STATUS_COLORS_HEX: Record<string, string> = {
  open: colors.fg.muted,
  in_progress: colors.status.info,
  done: colors.status.success,
  failed: colors.status.error,
  skipped: colors.fg.muted,
};

export const PRIORITY_COLORS_HEX: Record<number, string> = {
  1: colors.status.error,
  2: colors.status.warning,
  3: colors.status.info,
  4: colors.fg.muted,
  5: colors.fg.muted,
};

// ANSI escape codes for non-TUI (CLI-only) paths
export const ansi = {
  primary: "\x1b[36m",
  success: "\x1b[32m",
  warning: "\x1b[33m",
  error: "\x1b[31m",
  muted: "\x1b[90m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
};

export const fmt = {
  success: (msg: string) => `${ansi.success}\u2713${ansi.reset} ${msg}`,
  error:   (msg: string) => `${ansi.error}\u2717${ansi.reset} ${msg}`,
  info:    (msg: string) => `${ansi.primary}\u25CF${ansi.reset} ${msg}`,
  warn:    (msg: string) => `${ansi.warning}\u25B2${ansi.reset} ${msg}`,
  dim:     (msg: string) => `${ansi.muted}${msg}${ansi.reset}`,
  bold:    (msg: string) => `${ansi.bold}${msg}${ansi.reset}`,
  label:   (k: string, v: string) => `${ansi.muted}${k}${ansi.reset} ${v}`,
};

// Legacy ANSI-based maps for non-TUI paths (cli.tsx plain text mode)
export const STATUS_ICONS: Record<string, string> = {
  open: "\u25CB",
  in_progress: "\u25D0",
  done: "\u2713",
  failed: "\u2717",
  skipped: "\u2298",
};

export const STATUS_COLORS: Record<string, string> = {
  open: ansi.muted,
  in_progress: ansi.primary,
  done: ansi.success,
  failed: ansi.error,
  skipped: ansi.muted,
};

export const PRIORITY_COLORS: Record<number, string> = {
  1: ansi.error,
  2: ansi.warning,
  3: ansi.primary,
  4: ansi.muted,
  5: ansi.muted,
};
