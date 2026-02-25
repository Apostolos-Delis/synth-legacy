import type { CommandModule } from "yargs";
import { VERSION } from "./helpers.js";
import { ansi } from "../tui/theme.js";

const versionCommand: CommandModule = {
  command: "version",
  aliases: [],
  describe: "Show synth version",
  builder: {},
  handler() {
    console.log(
      `${ansi.bold}synth${ansi.reset} ${ansi.muted}v${VERSION}${ansi.reset}`,
    );
  },
};

export default versionCommand;
