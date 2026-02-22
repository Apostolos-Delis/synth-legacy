import type { ThemeColors } from "../theme";

export const theme: ThemeColors = {
  bg: { primary: "#1a1b26", secondary: "#24283b", highlight: "#292e42" },
  fg: { primary: "#c0caf5", secondary: "#a9b1d6", muted: "#565f89", dim: "#3b4261" },
  status: { success: "#9ece6a", warning: "#e0af68", error: "#f7768e", info: "#7dcfff" },
  accent: { primary: "#7aa2f7", secondary: "#bb9af7" },
  border: { normal: "#3b4261", active: "#7aa2f7", muted: "#292e42" },
};

export const defaultSpinner = "braille";
