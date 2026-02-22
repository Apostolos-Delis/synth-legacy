import type { ThemeColors } from "../theme";

export const theme: ThemeColors = {
  bg: { primary: "#282a36", secondary: "#21222c", highlight: "#44475a" },
  fg: { primary: "#f8f8f2", secondary: "#e2e2dc", muted: "#6272a4", dim: "#44475a" },
  status: { success: "#50fa7b", warning: "#f1fa8c", error: "#ff5555", info: "#8be9fd" },
  accent: { primary: "#bd93f9", secondary: "#ff79c6" },
  border: { normal: "#44475a", active: "#bd93f9", muted: "#383a46" },
};

export const defaultSpinner = "braille";
