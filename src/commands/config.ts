import { join } from "node:path";
import type { CommandModule } from "yargs";
import { loadConfig } from "../config/loader.js";
import { globalConfigPath } from "../config/paths.js";
import { PERSONAL_CONFIG_TEMPLATE } from "../config/defaults.js";
import { writeText, readText, fileExists } from "../utils/fs.js";
import { ansi, fmt, initTheme } from "../tui/theme.js";
import { resolveTheme } from "../tui/themes/resolve.js";

interface ConfigArgs {
  global: boolean;
  edit: boolean;
}

async function applyTheme(cwd: string) {
  const config = await loadConfig(cwd);
  const { theme, spinnerFrames } = await resolveTheme(config);
  initTheme(theme, spinnerFrames);
  return config;
}

async function ensureSynthToml(cwd: string): Promise<void> {
  const configPath = join(cwd, "synth.toml");
  if (await fileExists(configPath)) return;

  console.log(fmt.info("No synth.toml found, creating one..."));
  const examplePath = join(import.meta.dir, "..", "..", "synth.toml.example");
  let template: string;
  if (await fileExists(examplePath)) {
    template = await readText(examplePath);
  } else {
    const name = cwd.split("/").pop() ?? "my-project";
    template = `# Project config — personal prefs go in: synth config --global --edit

[project]
name = "${name}"
branch = "feature/synth"

[execution]
max_iterations = 20
iteration_delay = 2000
auto_commit = true

[guardrails]
max_consecutive_failures = 3
backpressure_commands = []

[finalize]
auto_format = true
split_commits = true
self_review = true
create_pr = true
`;
  }

  await writeText(configPath, template);
  console.log(fmt.success("Created synth.toml"));
}

const configCommand: CommandModule<object, ConfigArgs> = {
  command: "config",
  describe: "Display or edit configuration",
  builder: (yargs) =>
    yargs
      .option("global", {
        type: "boolean",
        describe: "Use personal/global config",
        default: false,
      })
      .option("edit", {
        type: "boolean",
        describe: "Open config in $EDITOR",
        default: false,
      })
      .example("synth config", "Show merged configuration")
      .example("synth config --edit", "Edit project synth.toml in $EDITOR")
      .example("synth config --global --edit", "Edit personal config in $EDITOR"),
  handler: async (argv) => {
    const cwd = process.cwd();

    if (argv.global) {
      const gp = globalConfigPath();
      if (argv.edit) {
        if (!(await fileExists(gp))) {
          await writeText(gp, PERSONAL_CONFIG_TEMPLATE);
          console.log(fmt.success(`Created ${gp}`));
        }
        const editor = process.env.EDITOR || process.env.VISUAL || "vi";
        const parts = editor.split(/\s+/);
        const proc = Bun.spawn([...parts, gp], {
          stdio: ["inherit", "inherit", "inherit"],
        });
        await proc.exited;
        try {
          await loadConfig(cwd);
          console.log(fmt.success("Config valid"));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(fmt.error(`Config error: ${message}`));
        }
      } else {
        if (!(await fileExists(gp))) {
          console.log(fmt.info(`No personal config found at ${gp}`));
          console.log(fmt.dim(`Create one with: synth config --global --edit`));
          return;
        }
        const raw = await readText(gp);
        console.log(raw);
      }
      return;
    }

    if (argv.edit) {
      const configPath = join(cwd, "synth.toml");
      if (!(await fileExists(configPath))) {
        await ensureSynthToml(cwd);
      }
      const editor = process.env.EDITOR || process.env.VISUAL || "vi";
      const parts = editor.split(/\s+/);
      const proc = Bun.spawn([...parts, configPath], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      await proc.exited;

      try {
        await loadConfig(cwd);
        console.log(fmt.success("Config valid"));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(fmt.error(`Config error: ${message}`));
      }
      return;
    }

    const config = await applyTheme(cwd);
    const json = JSON.stringify(config, null, 2);
    const colorized = json
      .replace(/"([^"]+)":/g, `${ansi.primary}"$1"${ansi.reset}:`)
      .replace(/: "([^"]+)"/g, `: ${ansi.success}"$1"${ansi.reset}`)
      .replace(/: (\d+)/g, `: ${ansi.warning}$1${ansi.reset}`)
      .replace(/: (true|false)/g, `: ${ansi.magenta}$1${ansi.reset}`);
    console.log(colorized);
  },
};

export default configCommand;
