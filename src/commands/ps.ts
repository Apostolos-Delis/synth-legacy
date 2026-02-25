import { listSessions } from "../sessions/registry.js";
import { ansi, fmt } from "../tui/theme.js";

export interface CommandModule<T = object> {
  command: string;
  describe: string;
  builder?: Record<string, never> | ((yargs: T) => T);
  handler: (argv: T) => void | Promise<void>;
  examples?: Array<[string, string]>;
}

const psCommand: CommandModule = {
  command: "ps",
  describe: "List running synth instances",
  builder: {},
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
  examples: [["synth ps", "List running synth instances"]],
};

export default psCommand;
