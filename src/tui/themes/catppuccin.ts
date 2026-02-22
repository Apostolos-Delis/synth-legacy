import type { ThemeColors } from "../theme";

// Catppuccin Mocha palette
export const theme: ThemeColors = {
  bg: { primary: "#1e1e2e", secondary: "#181825", highlight: "#313244" },
  fg: { primary: "#cdd6f4", secondary: "#bac2de", muted: "#6c7086", dim: "#585b70" },
  status: { success: "#a6e3a1", warning: "#f9e2af", error: "#f38ba8", info: "#89b4fa" },
  accent: { primary: "#89b4fa", secondary: "#cba6f7" },
  border: { normal: "#585b70", active: "#89b4fa", muted: "#313244" },
};

export const defaultSpinner = "braille";
