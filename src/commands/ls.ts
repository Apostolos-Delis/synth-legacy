import { listSessions, listAllSessions } from "../sessions/registry.js";
import { ansi, fmt, STATUS_ICONS } from "../tui/theme.js";

import type { Argv } from "yargs";

interface CommandModule {
  command: string;
  describe: string;
  builder: (yargs: Argv) => Argv;
  handler: (args: Record<string, unknown>) => Promise<void>;
}

const lsCommand: CommandModule = {
  command: "ls",
  describe: "List sessions",
  builder: (yargs) =>
    yargs
      .option("all", {
        alias: "a",
        type: "boolean",
        describe: "Include completed/finalized sessions",
        default: false,
      })
      .option("global", {
        alias: "g",
        type: "boolean",
        describe: "List sessions across all repos",
        default: false,
      })
      .example("synth ls", "List active sessions in this repo")
      .example("synth ls --all", "Include completed/finalized sessions")
      .example("synth ls --global", "List sessions across all repos"),
  async handler(args) {
    const showAll = Boolean(args.all);
    const globalMode = Boolean(args.global);
    const cwd = process.cwd();

    const allPlans = globalMode ? await listAllSessions() : await listSessions(cwd);
    const plans = showAll
      ? allPlans
      : allPlans.filter((p) => p.status !== "completed" && p.status !== "finalized");

    if (plans.length === 0) {
      if (allPlans.length > 0) {
        console.log(fmt.dim(`All ${allPlans.length} session(s) are completed. Use 'synth ls --all' to show them.`));
      } else {
        console.log(fmt.dim("No sessions found. Run 'synth start' to create one."));
      }
      return;
    }

    const label = showAll
      ? globalMode ? "Sessions (all repos, all)" : "Sessions (all)"
      : globalMode ? "Sessions (all repos)" : "Sessions";
    const hidden = allPlans.length - plans.length;
    const suffix = hidden > 0 ? ` ${ansi.muted}(${hidden} completed hidden, use --all)${ansi.reset}` : "";
    console.log(`${fmt.bold(label)}${suffix}\n`);

    if (globalMode) {
      console.log(
        `  ${ansi.muted}${"#".padEnd(4)} ${"ID".padEnd(25)} ${"Repo".padEnd(22)} ${"Status".padEnd(12)} ${"Tasks".padEnd(10)} Created${ansi.reset}`,
      );
      console.log(`  ${ansi.muted}${"─".repeat(96)}${ansi.reset}`);
    } else {
      console.log(
        `  ${ansi.muted}${"#".padEnd(4)} ${"ID".padEnd(25)} ${"Status".padEnd(12)} ${"Tasks".padEnd(10)} Created${ansi.reset}`,
      );
      console.log(`  ${ansi.muted}${"─".repeat(74)}${ansi.reset}`);
    }

    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      const statusColor =
        plan.status === "completed" || plan.status === "finalized"
          ? ansi.success
          : plan.status === "executing"
            ? ansi.primary
            : plan.status === "failed" || plan.status === "blocked"
              ? ansi.error
              : ansi.muted;
      const icon = STATUS_ICONS[plan.status] ?? "○";
      const date = fmt.dim(new Date(plan.createdAt).toLocaleDateString());
      const repoCol = globalMode ? `${fmt.dim(plan.repoKey.padEnd(22))} ` : "";
      console.log(
        `  ${ansi.primary}${String(i + 1).padEnd(4)}${ansi.reset}${plan.id.padEnd(25)} ${repoCol}${statusColor}${icon} ${plan.status.padEnd(10)}${ansi.reset} ${`${plan.tasksCompleted}/${plan.taskCount}`.padEnd(10)} ${date}`,
      );
    }
  },
};

export default lsCommand;
