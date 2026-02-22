import { describe, test, expect } from "bun:test";
import { boldAttr, colors, SPINNER_FRAMES, initTheme, fullKeyboardShortcuts } from "../tui/theme.js";
import { listBuiltinThemes, getBuiltinTheme } from "../tui/themes/registry.js";
import { listSpinnerPresets, getSpinnerFrames } from "../tui/spinners.js";

describe("TUI theme", () => {
  test("boldAttr returns a number", () => {
    const attr = boldAttr();
    expect(typeof attr).toBe("number");
    expect(attr).toBeGreaterThan(0);
  });

  test("boldAttr is stable across calls", () => {
    expect(boldAttr()).toBe(boldAttr());
  });

  test("colors has required sections", () => {
    expect(colors.bg.primary).toBeDefined();
    expect(colors.fg.primary).toBeDefined();
    expect(colors.status.success).toBeDefined();
    expect(colors.accent.primary).toBeDefined();
    expect(colors.border.normal).toBeDefined();
  });

  test("SPINNER_FRAMES is non-empty", () => {
    expect(SPINNER_FRAMES.length).toBeGreaterThan(0);
  });

  test("fullKeyboardShortcuts has entries with required fields", () => {
    expect(fullKeyboardShortcuts.length).toBeGreaterThan(0);
    for (const shortcut of fullKeyboardShortcuts) {
      expect(shortcut.key).toBeDefined();
      expect(shortcut.description).toBeDefined();
      expect(shortcut.category).toBeDefined();
    }
  });
});

describe("theme registry", () => {
  test("lists all 7 built-in themes", () => {
    const themes = listBuiltinThemes();
    expect(themes).toHaveLength(7);
    const names = themes.map((t) => t.name);
    expect(names).toContain("tokyonight");
    expect(names).toContain("dracula");
    expect(names).toContain("gruvbox");
  });

  test("getBuiltinTheme returns colors for valid name", () => {
    const theme = getBuiltinTheme("tokyonight");
    expect(theme).toBeDefined();
    expect(theme!.bg.primary).toBeDefined();
  });

  test("getBuiltinTheme returns undefined for unknown name", () => {
    expect(getBuiltinTheme("nonexistent")).toBeUndefined();
  });
});

describe("spinners", () => {
  test("lists all 8 presets", () => {
    const presets = listSpinnerPresets();
    expect(presets).toHaveLength(8);
    expect(presets).toContain("dots");
    expect(presets).toContain("braille");
    expect(presets).toContain("arrows");
  });

  test("getSpinnerFrames returns frames for valid preset", () => {
    const frames = getSpinnerFrames("dots");
    expect(frames.length).toBeGreaterThan(0);
    expect(frames).toContain("⣾");
  });

  test("getSpinnerFrames throws for unknown preset", () => {
    expect(() => getSpinnerFrames("nonexistent")).toThrow();
  });
});

describe("initTheme", () => {
  test("applies theme colors and spinner frames", () => {
    const theme = getBuiltinTheme("dracula")!;
    const frames = getSpinnerFrames("moon");

    initTheme(theme, frames);

    expect(colors.bg.primary).toBe("#282a36");
    expect(colors.accent.primary).toBe("#bd93f9");
    expect(SPINNER_FRAMES).toEqual(frames);

    // Restore default
    const tokyonight = getBuiltinTheme("tokyonight")!;
    initTheme(tokyonight, getSpinnerFrames("braille"));
  });
});
