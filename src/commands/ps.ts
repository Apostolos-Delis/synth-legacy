import { listSessions } from "../sessions/registry.js";
import { ansi, fmt } from "../tui/theme.js";

import type { Argv } from "yargs";

export interface CommandModule<T = object> {
  command: string;
  describe: string;
  builder: (yargs: Argv) => Argv;
  handler: (argv: T) => void | Promise<void>;
}

const psCommand: CommandModule = {
  command: "ps",
  describe: "List running synth instances",
  builder: (yargs) =>
    yargs.example("synth ps", "List running synth instances"),
  handler: async () => {
    const cwd = process.cwd();
    const plans = await listSessions(cwd);
    const running = plans.filter(
      (p) =>
        p.status === "executing" ||
        p.status === "reviewing" ||
        p.status === "finalizing",
    );

    if (running.length === 0) {
      console.log(fmt.dim("No running synth instances."));
      return;
    }

    console.log(fmt.bold("Running instances:") + "\n");
    for (const plan of running) {
      console.log(
        `  ${ansi.success}●${ansi.reset} ${plan.id} ${ansi.muted}─${ansi.reset} ${plan.description}`,
      );
    }
  },
};

export default psCommand;
