import { parse } from "smol-toml";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { ThemeColors } from "../theme.js";
import type { SynthConfig } from "../../config/types.js";
import { getBuiltinTheme, listAllThemeNames } from "./registry.js";
import { getSpinnerFrames, listSpinnerPresets } from "../spinners.js";
import { fileExists, readText } from "../../utils/fs.js";

const CUSTOM_THEMES_DIR = join(homedir(), ".config", "synth", "themes");

const REQUIRED_KEYS: [string, string][] = [
  ["bg", "primary"],
  ["bg", "secondary"],
  ["bg", "highlight"],
  ["fg", "primary"],
  ["fg", "secondary"],
  ["fg", "muted"],
  ["fg", "dim"],
  ["status", "success"],
  ["status", "warning"],
  ["status", "error"],
  ["status", "info"],
  ["accent", "primary"],
  ["accent", "secondary"],
  ["border", "normal"],
  ["border", "active"],
  ["border", "muted"],
];

function validateThemeColors(data: Record<string, unknown>, source: string): ThemeColors {
  const missing: string[] = [];

  for (const [group, key] of REQUIRED_KEYS) {
    const section = data[group];
    if (!section || typeof section !== "object" || !(key in (section as Record<string, unknown>))) {
      missing.push(`${group}.${key}`);
    }
  }

  if (missing.length > 0) {
    console.error(`Error: Malformed custom theme file: ${source}`);
    console.error(`Missing required keys: ${missing.join(", ")}`);
    process.exit(1);
  }

  return {
    bg: data.bg as ThemeColors["bg"],
    fg: data.fg as ThemeColors["fg"],
    status: data.status as ThemeColors["status"],
    accent: data.accent as ThemeColors["accent"],
    border: data.border as ThemeColors["border"],
  };
}

async function loadCustomThemeFile(path: string): Promise<{ theme: ThemeColors; defaultSpinner?: string }> {
  if (!(await fileExists(path))) {
    return null as never; // caller checks existence first
  }
  const raw = await readText(path);
  const data = parse(raw) as Record<string, unknown>;
  const theme = validateThemeColors(data, path);
  const defaultSpinner = typeof data.defaultSpinner === "string" ? data.defaultSpinner : undefined;
  return { theme, defaultSpinner };
}

export async function resolveTheme(
  config: SynthConfig,
): Promise<{ theme: ThemeColors; spinnerFrames: string[] }> {
  const themeName = config.tui?.theme ?? "tokyonight";
  let theme: ThemeColors | undefined;
  let themeDefaultSpinner = "braille";

  // 1. Check built-in themes
  const builtin = getBuiltinTheme(themeName);
  if (builtin) {
    theme = builtin;
    // Dynamically import the builtin theme module to get its defaultSpinner
    const builtinModules: Record<string, () => Promise<{ defaultSpinner?: string }>> = {
      tokyonight: () => import("./tokyonight.js"),
      onedark: () => import("./onedark.js"),
      catppuccin: () => import("./catppuccin.js"),
      dracula: () => import("./dracula.js"),
      solarized: () => import("./solarized.js"),
      nord: () => import("./nord.js"),
      gruvbox: () => import("./gruvbox.js"),
    };
    const loader = builtinModules[themeName];
    if (loader) {
      const mod = await loader();
      if (mod.defaultSpinner) {
        themeDefaultSpinner = mod.defaultSpinner;
      }
    }
  }

  // 2. Check ~/.config/synth/themes/<name>.toml
  if (!theme) {
    const customPath = join(CUSTOM_THEMES_DIR, `${themeName}.toml`);
    if (await fileExists(customPath)) {
      const result = await loadCustomThemeFile(customPath);
      theme = result.theme;
      if (result.defaultSpinner) {
        themeDefaultSpinner = result.defaultSpinner;
      }
    }
  }

  // 3. Check if it's an absolute path to a .toml file
  if (!theme && isAbsolute(themeName) && themeName.endsWith(".toml")) {
    if (await fileExists(themeName)) {
      const result = await loadCustomThemeFile(themeName);
      theme = result.theme;
      if (result.defaultSpinner) {
        themeDefaultSpinner = result.defaultSpinner;
      }
    }
  }

  // 4. Invalid theme name
  if (!theme) {
    const available = await listAllThemeNames();
    console.error(`Error: Unknown theme "${themeName}"`);
    console.error(`Available themes: ${available.join(", ")}`);
    process.exit(1);
  }

  // Resolve spinner
  const spinnerName = config.tui?.spinner ?? themeDefaultSpinner;
  let spinnerFrames: string[];
  try {
    spinnerFrames = getSpinnerFrames(spinnerName);
  } catch {
    console.error(`Error: Unknown spinner preset "${spinnerName}"`);
    console.error(`Available presets: ${listSpinnerPresets().join(", ")}`);
    process.exit(1);
  }

  return { theme, spinnerFrames };
}
