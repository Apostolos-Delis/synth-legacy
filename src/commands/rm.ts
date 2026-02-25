import type { CommandModule, ArgumentsCamelCase, Argv } from "yargs";
import { listSessions, deleteSession } from "../sessions/registry.js";
import { ansi, fmt } from "../tui/theme.js";

interface RmArgs {
  ids?: string[];
  stale?: boolean;
}

const TERMINAL_STATUSES = new Set(["completed", "finalized", "failed"]);
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function resolvePlanId(input: string): Promise<string | undefined> {
  if (/^\d+$/.test(input)) {
    const cwd = process.cwd();
    const allPlans = await listSessions(cwd);
    const plans = allPlans.filter(
      (p) => p.status !== "completed" && p.status !== "finalized",
    );
    const idx = parseInt(input, 10) - 1;
    if (idx < 0 || idx >= plans.length) {
      if (idx >= 0 && idx < allPlans.length) {
        const session = allPlans[idx];
        console.error(
          fmt.error(
            `Session #${input} is already ${session.status}. Run 'synth ls --all' to see all sessions.`,
          ),
        );
      } else {
        console.error(
          fmt.error(
            `Session #${input} not found. Run 'synth ls' to see available sessions.`,
          ),
        );
      }
      process.exit(1);
    }
    return plans[idx].id;
  }
  return input;
}

const rmCommand: CommandModule<object, RmArgs> = {
  command: "rm [ids..]",
  describe: "Remove sessions",
  builder(yargs: Argv) {
    return yargs
      .positional("ids", {
        type: "string",
        array: true,
        describe: "Session IDs to remove",
      })
      .option("stale", {
        type: "boolean",
        describe: "Remove sessions inactive for >7 days",
        default: false,
      })
      .example("$0 rm my-session", "Remove a single session")
      .example("$0 rm --stale", "Remove all stale sessions");
  },
  async handler(argv: ArgumentsCamelCase<RmArgs>) {
    const ids = argv.ids ?? [];
    const staleFlag = argv.stale ?? false;

    if (!staleFlag && ids.length === 0) {
      console.log("Usage: synth rm <id> [<id>...]");
      console.log("       synth rm --stale");
      return;
    }

    const cwd = process.cwd();

    if (staleFlag) {
      const sessions = await listSessions(cwd);
      const now = Date.now();
      const stale = sessions.filter(
        (s) =>
          !TERMINAL_STATUSES.has(s.status) &&
          now - new Date(s.updatedAt).getTime() > STALE_THRESHOLD_MS,
      );

      if (stale.length === 0) {
        console.log(fmt.dim("No stale sessions found."));
        return;
      }

      console.log(fmt.bold(`Removing ${stale.length} stale session(s):\n`));
      for (const s of stale) {
        const date = fmt.dim(new Date(s.updatedAt).toLocaleDateString());
        const deleted = await deleteSession(cwd, s.id);
        if (deleted) {
          console.log(
            fmt.success(
              `${s.id} ${ansi.muted}(${s.status}, last updated ${date})${ansi.reset}`,
            ),
          );
        } else {
          console.error(fmt.error(`${s.id} — not found on disk`));
        }
      }
      return;
    }

    for (const id of ids) {
      const resolved = await resolvePlanId(id);
      if (!resolved) continue;
      const deleted = await deleteSession(cwd, resolved);
      if (deleted) {
        console.log(fmt.success(`Removed ${resolved}`));
      } else {
        console.error(fmt.error(`Session '${resolved}' not found`));
      }
    }
  },
};

export default rmCommand;
