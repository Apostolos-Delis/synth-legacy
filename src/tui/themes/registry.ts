import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ThemeColors } from "../theme.js";
import { theme as tokyonight } from "./tokyonight.js";
import { theme as onedark } from "./onedark.js";
import { theme as catppuccin } from "./catppuccin.js";
import { theme as dracula } from "./dracula.js";
import { theme as solarized } from "./solarized.js";
import { theme as nord } from "./nord.js";
import { theme as gruvbox } from "./gruvbox.js";

export type BuiltinThemeName =
  | "tokyonight"
  | "onedark"
  | "catppuccin"
  | "dracula"
  | "solarized"
  | "nord"
  | "gruvbox";

export const BUILTIN_THEMES: Record<BuiltinThemeName, ThemeColors> = {
  tokyonight,
  onedark,
  catppuccin,
  dracula,
  solarized,
  nord,
  gruvbox,
};

export function getBuiltinTheme(name: string): ThemeColors | undefined {
  return BUILTIN_THEMES[name as BuiltinThemeName];
}

export function listBuiltinThemes(): { name: BuiltinThemeName; theme: ThemeColors }[] {
  return (Object.keys(BUILTIN_THEMES) as BuiltinThemeName[]).map((name) => ({
    name,
    theme: BUILTIN_THEMES[name],
  }));
}

const CUSTOM_THEMES_DIR = join(homedir(), ".config", "synth", "themes");

export async function discoverCustomThemes(): Promise<string[]> {
  try {
    const entries = await readdir(CUSTOM_THEMES_DIR);
    return entries
      .filter((f) => f.endsWith(".toml"))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

export async function listAllThemeNames(): Promise<string[]> {
  const builtin = Object.keys(BUILTIN_THEMES);
  const custom = await discoverCustomThemes();
  return [...builtin, ...custom];
}
