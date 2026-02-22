import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { resolveTheme } from "../tui/themes/resolve.js";
import { initTheme, colors, SPINNER_FRAMES } from "../tui/theme.js";
import { getBuiltinTheme, type BuiltinThemeName } from "../tui/themes/registry.js";
import { getSpinnerFrames } from "../tui/spinners.js";
import { writeText } from "../utils/fs.js";
import { withTmpDir } from "./helpers.js";
import type { SynthConfig } from "../config/types.js";

function makeConfig(tui?: SynthConfig["tui"]): SynthConfig {
  return {
    project: { name: "test", branch: "test", base_branch: "main" },
    agent: { name: "claude", timeout: 300, skip_permissions: true },
    execution: { max_iterations: 5, iteration_delay: 0, auto_commit: false },
    guardrails: { max_consecutive_failures: 3, backpressure_commands: [] },
    finalize: { auto_format: false, split_commits: false, self_review: false, create_pr: false },
    tui,
  };
}

const originalExit = process.exit;

afterEach(() => {
  process.exit = originalExit;
  const tokyonight = getBuiltinTheme("tokyonight")!;
  initTheme(tokyonight, getSpinnerFrames("braille"));
});

describe("resolveTheme", () => {
  const builtinNames: BuiltinThemeName[] = [
    "tokyonight", "onedark", "catppuccin", "dracula", "solarized", "nord", "gruvbox",
  ];

  for (const name of builtinNames) {
    test(`resolves built-in theme: ${name}`, async () => {
      const result = await resolveTheme(makeConfig({ theme: name }));
      expect(result.theme.bg.primary).toBeDefined();
      expect(result.theme.fg.primary).toBeDefined();
      expect(result.spinnerFrames.length).toBeGreaterThan(0);
    });
  }

  test("resolves custom theme from absolute .toml path", async () => {
    await withTmpDir(async (dir) => {
      const tomlPath = join(dir, "custom.toml");
      await writeText(tomlPath, `
[bg]
primary = "#111111"
secondary = "#222222"
highlight = "#333333"

[fg]
primary = "#ffffff"
secondary = "#eeeeee"
muted = "#aaaaaa"
dim = "#666666"

[status]
success = "#00ff00"
warning = "#ffff00"
error = "#ff0000"
info = "#00ffff"

[accent]
primary = "#ff00ff"
secondary = "#ff7700"

[border]
normal = "#444444"
active = "#ff00ff"
muted = "#333333"
`);
      const result = await resolveTheme(makeConfig({ theme: tomlPath }));
      expect(result.theme.bg.primary).toBe("#111111");
      expect(result.theme.accent.primary).toBe("#ff00ff");
    });
  });

  test("resolves custom theme with defaultSpinner override", async () => {
    await withTmpDir(async (dir) => {
      const tomlPath = join(dir, "custom-spinner.toml");
      await writeText(tomlPath, `
defaultSpinner = "moon"

[bg]
primary = "#111111"
secondary = "#222222"
highlight = "#333333"

[fg]
primary = "#ffffff"
secondary = "#eeeeee"
muted = "#aaaaaa"
dim = "#666666"

[status]
success = "#00ff00"
warning = "#ffff00"
error = "#ff0000"
info = "#00ffff"

[accent]
primary = "#ff00ff"
secondary = "#ff7700"

[border]
normal = "#444444"
active = "#ff00ff"
muted = "#333333"
`);
      const result = await resolveTheme(makeConfig({ theme: tomlPath }));
      const moonFrames = getSpinnerFrames("moon");
      expect(result.spinnerFrames).toEqual(moonFrames);
    });
  });

  test("uses config.tui.spinner override when set", async () => {
    const result = await resolveTheme(makeConfig({ theme: "dracula", spinner: "moon" }));
    const moonFrames = getSpinnerFrames("moon");
    expect(result.spinnerFrames).toEqual(moonFrames);
  });

  test("defaults to tokyonight when tui.theme is undefined", async () => {
    const result = await resolveTheme(makeConfig());
    const tokyonight = getBuiltinTheme("tokyonight")!;
    expect(result.theme.bg.primary).toBe(tokyonight.bg.primary);
  });

  test("defaults to braille spinner when none specified", async () => {
    const result = await resolveTheme(makeConfig({ theme: "dracula" }));
    const brailleFrames = getSpinnerFrames("braille");
    expect(result.spinnerFrames).toEqual(brailleFrames);
  });

  test("malformed custom .toml exits with code 1", async () => {
    await withTmpDir(async (dir) => {
      const tomlPath = join(dir, "bad.toml");
      await writeText(tomlPath, `
[bg]
primary = "#111111"
`);
      let exitCode: number | undefined;
      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error("process.exit called");
      }) as never;

      try {
        await resolveTheme(makeConfig({ theme: tomlPath }));
      } catch (e: unknown) {
        if (e instanceof Error && e.message !== "process.exit called") throw e;
      }
      expect(exitCode).toBe(1);
    });
  });
});

describe("resolveTheme + initTheme integration", () => {
  test("dracula theme applies correct colors", async () => {
    const { theme, spinnerFrames } = await resolveTheme(makeConfig({ theme: "dracula" }));
    initTheme(theme, spinnerFrames);
    expect(colors.bg.primary).toBe("#282a36");
    expect(colors.accent.primary).toBe("#bd93f9");
  });

  test("moon spinner override applies correct frames", async () => {
    const { theme, spinnerFrames } = await resolveTheme(makeConfig({ theme: "tokyonight", spinner: "moon" }));
    initTheme(theme, spinnerFrames);
    const moonFrames = getSpinnerFrames("moon");
    expect(SPINNER_FRAMES).toEqual(moonFrames);
  });
});
