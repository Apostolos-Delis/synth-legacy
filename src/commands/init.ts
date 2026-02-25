import { join } from "node:path";
import type { Argv, CommandModule } from "yargs";
import { writeText, readText, fileExists } from "../utils/fs.js";
import { fmt } from "../tui/theme.js";

const initCommand: CommandModule = {
  command: "init",
  describe: "Create a synth.toml configuration file",
  builder: (yargs: Argv) =>
    yargs.example("synth init", "Create a synth.toml configuration file"),
  handler: async () => {
    const cwd = process.cwd();
    const configPath = join(cwd, "synth.toml");
    if (await fileExists(configPath)) {
      console.log(fmt.warn("synth.toml already exists"));
      return;
    }

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
  },
};

export default initCommand;
