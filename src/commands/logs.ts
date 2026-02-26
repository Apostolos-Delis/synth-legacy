import { getSession, listSessions } from "../sessions/registry.js";
import { fileExists, readText } from "../utils/fs.js";
import { fmt } from "../tui/theme.js";

import type { Argv } from "yargs";

interface CommandModule {
  command: string;
  describe: string;
  builder: (yargs: Argv) => Argv;
  handler: (args: Record<string, unknown>) => Promise<void>;
}

async function resolvePlanId(input?: string): Promise<string | undefined> {
  if (!input) return undefined;
  const cwd = process.cwd();
  if (/^\d+$/.test(input)) {
    const allPlans = await listSessions(cwd);
    const plans = allPlans.filter((p) => p.status !== "completed" && p.status !== "finalized");
    const idx = parseInt(input, 10) - 1;
    if (idx < 0 || idx >= plans.length) {
      if (idx >= 0 && idx < allPlans.length) {
        const session = allPlans[idx];
        console.error(fmt.error(`Session #${input} is already ${session.status}. Run 'synth ls --all' to see all sessions.`));
      } else {
        console.error(fmt.error(`Session #${input} not found. Run 'synth ls' to see available sessions.`));
      }
      process.exit(1);
    }
    return plans[idx].id;
  }
  return input;
}

const logsCommand: CommandModule = {
  command: "logs <session-id>",
  describe: "Show session logs",
  builder: (yargs) =>
    yargs
      .positional("session-id", {
        type: "string",
        describe: "Session ID or numeric index",
        demandOption: true,
      })
      .option("tail", {
        alias: "t",
        type: "boolean",
        describe: "Tail session log",
        default: false,
      })
      .option("lines", {
        alias: "n",
        type: "number",
        describe: "Lines to show when tailing logs",
        default: 200,
      })
      .example("synth logs my-session", "Show full session log")
      .example("synth logs -t my-session", "Tail the session log"),
  async handler(args) {
    const cwd = process.cwd();
    const sessionId = await resolvePlanId(args["session-id"] as string);
    if (!sessionId) {
      console.error(fmt.error("Usage: synth logs <session-id>"));
      process.exit(1);
    }

    const plan = await getSession(cwd, sessionId);
    if (!plan) {
      console.error(fmt.error(`Session '${sessionId}' not found`));
      process.exit(1);
    }

    if (!(await fileExists(plan.paths.sessionLog))) {
      console.error(fmt.error(`Session log not found: ${plan.paths.sessionLog}`));
      process.exit(1);
    }

    const content = await readText(plan.paths.sessionLog);
    if (args.tail === true) {
      const requestedLines = typeof args.lines === "number" && args.lines > 0
        ? Math.floor(args.lines)
        : 200;
      const lines = content.trimEnd().split("\n");
      const tail = lines.slice(-requestedLines);
      console.log(fmt.bold(`Session Log: ${plan.metadata.id} (last ${requestedLines} lines)`));
      console.log(tail.join("\n"));
      return;
    }

    console.log(fmt.bold(`Session Log: ${plan.metadata.id}`));
    console.log(content);
  },
};

export default logsCommand;
