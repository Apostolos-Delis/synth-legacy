import type { CommandModule } from "yargs";
import { VERSION } from "./helpers.js";
import { ansi } from "../tui/theme.js";

const versionCommand: CommandModule = {
  command: "version",
  aliases: [],
  describe: "Show synth version",
  builder: (yargs) =>
    yargs
      .example("synth version", "Print the current synth version")
      .example("synth version", "Check which version is installed"),
  handler() {
    console.log(
      `${ansi.bold}synth${ansi.reset} ${ansi.muted}v${VERSION}${ansi.reset}`,
    );
  },
};

export default versionCommand;
