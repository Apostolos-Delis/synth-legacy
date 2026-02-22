import type { ThemeColors } from "../theme";

// Gruvbox Dark palette
export const theme: ThemeColors = {
  bg: { primary: "#282828", secondary: "#1d2021", highlight: "#3c3836" },
  fg: { primary: "#ebdbb2", secondary: "#d5c4a1", muted: "#665c54", dim: "#504945" },
  status: { success: "#b8bb26", warning: "#fabd2f", error: "#fb4934", info: "#83a598" },
  accent: { primary: "#83a598", secondary: "#d3869b" },
  border: { normal: "#504945", active: "#83a598", muted: "#3c3836" },
};

export const defaultSpinner = "braille";
