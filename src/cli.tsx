#!/usr/bin/env bun

import yargs from "yargs";
import { commands } from "./commands/index.js";
import { VERSION } from "./commands/helpers.js";
import { globalTrace, formatProfileReport, formatProfileReportJson } from "./utils/perf.js";

// Re-export for backward compatibility (used by tests)
export { parseWorktreeFlag } from "./commands/start.js";
export { buildSummaryMarkdown } from "./commands/helpers.js";

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

// Show help when no command is given
cli.demandCommand(1, "").showHelpOnFail(true);

cli.parse();

// Profile report fires after yargs completes
process.on("exit", () => {
  printProfileReport();
});
