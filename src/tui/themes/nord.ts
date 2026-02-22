import type { ThemeColors } from "../theme";

export const theme: ThemeColors = {
  bg: { primary: "#2e3440", secondary: "#3b4252", highlight: "#434c5e" },
  fg: { primary: "#d8dee9", secondary: "#e5e9f0", muted: "#4c566a", dim: "#434c5e" },
  status: { success: "#a3be8c", warning: "#ebcb8b", error: "#bf616a", info: "#81a1c1" },
  accent: { primary: "#81a1c1", secondary: "#b48ead" },
  border: { normal: "#4c566a", active: "#81a1c1", muted: "#434c5e" },
};

export const defaultSpinner = "braille";
