import { getSession, listSessions } from "../sessions/registry.js";
import { loadTasks, getProgress } from "../tasks/store.js";
import { fileExists } from "../utils/fs.js";
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

const showCommand: CommandModule = {
  command: "show <session-id>",
  describe: "Show session details",
  builder: (yargs) =>
    yargs
      .positional("session-id", {
        type: "string",
        describe: "Session ID or numeric index",
        demandOption: true,
      })
      .example("synth show my-session", "Show details for session 'my-session'")
      .example("synth show 1", "Show details for session #1"),
  async handler(args) {
    const cwd = process.cwd();
    const sessionId = await resolvePlanId(args["session-id"] as string);
    if (!sessionId) {
      console.error(fmt.error("Usage: synth show <session-id>"));
      process.exit(1);
    }

    const plan = await getSession(cwd, sessionId);
    if (!plan) {
      console.error(fmt.error(`Session '${sessionId}' not found`));
      process.exit(1);
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

export default showCommand;
