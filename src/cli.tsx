#!/usr/bin/env bun

import yargs from "yargs";
import { commands } from "./commands/index.js";
import { VERSION } from "./commands/helpers.js";
import { globalTrace, formatProfileReport, formatProfileReportJson } from "./utils/perf.js";
import { cmdStart } from "./commands/start.js";

// ── Profile report ──

let profileJson = false;

function printProfileReport(): void {
  const trace = globalTrace();
  if (!trace.enabled) return;
  const report = trace.report();
  if (report.phases.length === 0) return;

  if (profileJson) {
    process.stderr.write(formatProfileReportJson(report) + "\n");
  } else {
    process.stderr.write(formatProfileReport(report) + "\n");
  }
}

// ── Yargs entrypoint ──

const cli = yargs(process.argv.slice(2))
  .scriptName("synth")
  .version(VERSION)
  .alias("v", "version")
  .help()
  .alias("h", "help")
  .strictCommands()
  .option("parallel", {
    type: "number",
    describe: "Force parallel execution (default: 8 workers)",
    conflicts: "no-parallel",
    group: "Global Options:",
  })
  .option("no-parallel", {
    type: "boolean",
    describe: "Force serial execution",
    group: "Global Options:",
  })
  .option("no-tui", {
    type: "boolean",
    describe: "Disable TUI (plain text output)",
    group: "Global Options:",
  })
  .option("profile", {
    type: "boolean",
    describe: "Print timing report to stderr on exit",
    group: "Global Options:",
  })
  .option("profile-json", {
    type: "boolean",
    describe: "Print timing report as JSON to stderr on exit",
    group: "Global Options:",
  })
  .middleware((argv) => {
    if (argv.profile || argv.profileJson) {
      globalTrace().enabled = true;
      profileJson = !!argv.profileJson;
    }
  });

// Register all command modules
for (const cmd of commands) {
  cli.command(cmd);
}

// Default command: launch TUI when no subcommand is given (US-005)
cli.command(
  "$0",
  false, // hidden from help
  () => {},
  async (argv) => {
    // Reject unknown commands — strictCommands doesn't catch them with a $0 handler
    const positionals = argv._;
    if (positionals.length > 0) {
      process.stderr.write(`Unknown command: ${positionals[0]}\n`);
      cli.showHelp();
      process.exit(1);
    }

    const cwd = process.cwd();
    const tuiEnabled = process.stdout.isTTY === true && !process.argv.includes("--no-tui");

    const rawArgs = process.argv.slice(2);
    const noParallelFlag = rawArgs.includes("--no-parallel");
    const parallelIndex = rawArgs.indexOf("--parallel");
    let parallelMode = false;
    let parallelWorkers: number | undefined;
    if (noParallelFlag) {
      parallelMode = false;
    } else if (parallelIndex !== -1) {
      parallelMode = true;
      const next = rawArgs[parallelIndex + 1];
      if (next && /^\d+$/.test(next)) {
        parallelWorkers = parseInt(next, 10);
      }
    }

    if (!noParallelFlag && parallelIndex === -1) {
      const { loadConfig } = await import("./config/loader.js");
      const cfg = await loadConfig(cwd);
      parallelMode = cfg.parallel?.enabled ?? true;
    }

    await cmdStart(undefined, {
      cwd,
      tuiEnabled,
      parallelMode,
      parallelWorkers,
    });
  },
);

cli.parse();

// Profile report fires after yargs completes
process.on("exit", () => {
  printProfileReport();
});
