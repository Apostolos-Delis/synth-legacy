import type { CommandModule, ArgumentsCamelCase, Argv } from "yargs";
import { getSession, getMostRecentSession } from "../sessions/registry.js";
import { loadTasks, getProgress } from "../tasks/store.js";
import { fileExists } from "../utils/fs.js";
import { ansi, fmt } from "../tui/theme.js";

interface StatusArgs {
  "session-id"?: string;
}

async function loadRunModule() {
  const mod = await import("../run/run.js");
  return { loadRun: mod.loadRun };
}

const statusCommand: CommandModule<object, StatusArgs> = {
  command: "status [session-id]",
  describe: "Show session progress status",
  builder(yargs: Argv) {
    return yargs
      .positional("session-id", {
        type: "string",
        describe: "Session ID to show status for (defaults to most recent)",
      })
      .example("$0 status", "Show status of the most recent session")
      .example("$0 status my-session", "Show status of a specific session");
  },
  async handler(argv: ArgumentsCamelCase<StatusArgs>) {
    const cwd = process.cwd();
    const sessionId = argv["session-id"];

    let plan;
    if (sessionId) {
      plan = await getSession(cwd, sessionId);
    } else {
      plan = await getMostRecentSession(cwd);
    }

    if (!plan) {
      console.log(fmt.dim("No active session. Run 'synth start' to create one."));
      return;
    }

    console.log(`${fmt.bold(plan.metadata.id)} ${ansi.muted}─${ansi.reset} ${plan.metadata.status}`);

    if (await fileExists(plan.paths.tasks)) {
      const taskFile = await loadTasks(plan.paths.tasks);
      const progress = getProgress(taskFile);
      const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
      const barWidth = 20;
      const filled = Math.floor(pct / (100 / barWidth));
      const bar = `${ansi.success}${"▓".repeat(filled)}${ansi.muted}${"░".repeat(barWidth - filled)}${ansi.reset}`;
      console.log(`Progress: [${bar}] ${ansi.bold}${pct}%${ansi.reset} (${progress.done}/${progress.total})`);
    }

    const { loadRun } = await loadRunModule();
    const run = await loadRun(plan.paths);
    if (run) {
      console.log(fmt.label("Session:", `${run.status} (iteration ${run.currentIteration})`));
    }
  },
};

export default statusCommand;
