import type { CommandModule } from "yargs";
import rmCommand from "./rm.js";

const cleanCommand: CommandModule = {
  command: "clean",
  describe: "Remove stale sessions (alias for rm --stale)",
  builder: (yargs) =>
    yargs
      .example("synth clean", "Remove all stale sessions")
      .example("synth clean", "Same as synth rm --stale"),
  async handler() {
    await rmCommand.handler({ ids: [], stale: true, _: ["clean"], $0: "" });
  },
};

export default cleanCommand;
