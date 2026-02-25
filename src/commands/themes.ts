import type { CommandModule } from "yargs";
import { loadConfig } from "../config/loader.js";
import { resolveTheme } from "../tui/themes/resolve.js";
import { listBuiltinThemes, discoverCustomThemes } from "../tui/themes/registry.js";
import { listSpinnerPresets } from "../tui/spinners.js";
import { ansi, fmt, initTheme } from "../tui/theme.js";

const themesCommand: CommandModule = {
  command: "themes",
  describe: "List available themes and spinner presets",
  builder: {},
  handler: async () => {
    const config = await loadConfig(process.cwd());
    const { theme, spinnerFrames } = await resolveTheme(config);
    initTheme(theme, spinnerFrames);

    const activeTheme = config.tui?.theme ?? "tokyonight";
    const activeSpinner = config.tui?.spinner ?? "braille";

    // Built-in themes
    const builtins = listBuiltinThemes();
    console.log(fmt.bold("Built-in Themes:"));
    for (const { name } of builtins) {
      const marker = name === activeTheme ? ` ${ansi.success}● active${ansi.reset}` : "";
      console.log(`  ${ansi.primary}${name}${ansi.reset}${marker}`);
    }

    // Custom themes
    const custom = await discoverCustomThemes();
    if (custom.length > 0) {
      console.log(`\n${fmt.bold("Custom Themes:")} ${ansi.muted}(~/.config/synth/themes/)${ansi.reset}`);
      for (const name of custom) {
        const marker = name === activeTheme ? ` ${ansi.success}● active${ansi.reset}` : "";
        console.log(`  ${ansi.primary}${name}${ansi.reset}${marker}`);
      }
    } else {
      console.log(`\n${fmt.dim("No custom themes found in ~/.config/synth/themes/")}`);
    }

    // Spinner presets
    const spinners = listSpinnerPresets();
    console.log(`\n${fmt.bold("Spinner Presets:")}`);
    for (const name of spinners) {
      const marker = name === activeSpinner ? ` ${ansi.success}● active${ansi.reset}` : "";
      console.log(`  ${ansi.primary}${name}${ansi.reset}${marker}`);
    }
  },
};

export default themesCommand;
