import type { CommandModule } from "yargs";
import rmCommand from "./rm.js";

const cleanCommand: CommandModule = {
  command: "clean",
  describe: "Remove stale sessions (alias for rm --stale)",
  builder: {},
  async handler() {
    await rmCommand.handler({ ids: [], stale: true, _: ["clean"], $0: "" });
  },
};

export default cleanCommand;
