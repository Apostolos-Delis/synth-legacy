import type { ThemeColors } from "../theme";

// Solarized Dark palette
export const theme: ThemeColors = {
  bg: { primary: "#002b36", secondary: "#073642", highlight: "#073642" },
  fg: { primary: "#839496", secondary: "#93a1a1", muted: "#586e75", dim: "#073642" },
  status: { success: "#859900", warning: "#b58900", error: "#dc322f", info: "#268bd2" },
  accent: { primary: "#268bd2", secondary: "#6c71c4" },
  border: { normal: "#586e75", active: "#268bd2", muted: "#073642" },
};

export const defaultSpinner = "braille";
