import { getSession, listSessions } from "../sessions/registry.js";
import { loadTasks, getProgress } from "../tasks/store.js";
import { fileExists, readText } from "../utils/fs.js";
import { ansi, fmt, STATUS_ICONS, STATUS_COLORS } from "../tui/theme.js";

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

const sessionCommand: CommandModule = {
  command: "session <session-id>",
  describe: "Show session details",
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
      .example("synth session my-session", "Show details for session 'my-session'")
      .example("synth session 1", "Show details for session #1")
      .example("synth session -t my-session", "Tail the session log"),
  async handler(args) {
    const cwd = process.cwd();
    const sessionId = await resolvePlanId(args["session-id"] as string);
    if (!sessionId) {
      console.error(fmt.error("Usage: synth session <session-id>"));
      process.exit(1);
    }

    const plan = await getSession(cwd, sessionId);
    if (!plan) {
      console.error(fmt.error(`Session '${sessionId}' not found`));
      process.exit(1);
    }

    if (args.tail === true) {
      if (!(await fileExists(plan.paths.sessionLog))) {
        console.error(fmt.error(`Session log not found: ${plan.paths.sessionLog}`));
        process.exit(1);
      }

      const requestedLines = typeof args.lines === "number" && args.lines > 0
        ? Math.floor(args.lines)
        : 200;
      const content = await readText(plan.paths.sessionLog);
      const lines = content.trimEnd().split("\n");
      const tail = lines.slice(-requestedLines);
      console.log(fmt.bold(`Session Log: ${plan.metadata.id} (last ${requestedLines} lines)`));
      console.log(tail.join("\n"));
      return;
    }

    console.log(fmt.bold(`Session: ${plan.metadata.id}`));
    console.log(fmt.label("  Status:", plan.metadata.status));
    console.log(fmt.label("  Created:", plan.metadata.createdAt));
    console.log(fmt.label("  Updated:", plan.metadata.updatedAt));
    console.log(fmt.label("  Description:", plan.metadata.description));
    console.log("");

    if (await fileExists(plan.paths.tasks)) {
      const taskFile = await loadTasks(plan.paths.tasks);
      const progress = getProgress(taskFile);
      console.log(
        fmt.bold("Tasks:") + ` ${progress.done}/${progress.total} done, ${progress.failed} failed, ${progress.open} open`,
      );
      console.log("");
      for (const task of taskFile.tasks) {
        const icon = STATUS_ICONS[task.status] ?? "?";
        const color = STATUS_COLORS[task.status] ?? ansi.muted;
        console.log(`  ${color}${icon}${ansi.reset} ${task.id} ${task.title}`);
      }
    }

    if (await fileExists(plan.paths.prd)) {
      console.log(`\n${fmt.label("PRD:", plan.paths.prd)}`);
    }
  },
};

export default sessionCommand;
