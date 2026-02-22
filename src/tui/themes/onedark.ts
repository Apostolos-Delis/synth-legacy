import type { ThemeColors } from "../theme";

export const theme: ThemeColors = {
  bg: { primary: "#282c34", secondary: "#21252b", highlight: "#2c313c" },
  fg: { primary: "#abb2bf", secondary: "#9da5b4", muted: "#5c6370", dim: "#4b5263" },
  status: { success: "#98c379", warning: "#e5c07b", error: "#e06c75", info: "#61afef" },
  accent: { primary: "#61afef", secondary: "#c678dd" },
  border: { normal: "#4b5263", active: "#61afef", muted: "#2c313c" },
};

export const defaultSpinner = "braille";
