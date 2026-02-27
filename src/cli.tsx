#!/usr/bin/env bun

import yargs from "yargs";
import { commands, commandCategories } from "./commands/index.js";
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
  .help(false)
  .option("help", {
    alias: "h",
    type: "boolean",
    describe: "Show help",
  })
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
      process.env.SYNTH_TUI_PROFILE = "1";
    }
  });

// Register all command modules
for (const cmd of commands) {
  cli.command(cmd);
}

// ── Categorized help (US-002) ──

function buildCommandDescriptions(): Map<string, string> {
  const map = new Map<string, string>();
  for (const cmd of commands) {
    // command field may be "start [session-id]" — extract the base name
    const name = String(cmd.command).split(/\s/)[0];
    map.set(name, String(cmd.describe ?? ""));
  }
  return map;
}

function categorizedHelp(): string {
  const descs = buildCommandDescriptions();
  const lines: string[] = [];

  // Compute max command width across all categories for alignment
  let maxLen = 0;
  for (const [, cmds] of Object.entries(commandCategories)) {
    for (const name of cmds) {
      const full = `synth ${name}`;
      if (full.length > maxLen) maxLen = full.length;
    }
  }

  for (const [category, cmds] of Object.entries(commandCategories)) {
    lines.push(category);
    for (const name of cmds) {
      const full = `synth ${name}`;
      const desc = descs.get(name) ?? "";
      lines.push(`  ${full.padEnd(maxLen + 2)}${desc}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function showCategorizedHelp(): void {
  const helpText = cli.getHelp();

  const render = (text: string) => {
    // Replace the flat "Commands:" block with categorized output.
    // The "Commands:" block starts with the header and ends at the next
    // blank line followed by a group header (e.g. "Global Options:") or EOF.
    const replaced = text.replace(
      /^Commands:\n(?:.*\n)*?\n/m,
      categorizedHelp(),
    );
    process.stdout.write(replaced + "\n");
    process.exit(0);
  };

  if (typeof helpText === "string") {
    render(helpText);
  } else {
    // getHelp() may return a Promise
    (helpText as Promise<string>).then(render);
  }
}

// Default command: launch TUI when no subcommand is given (US-005)
cli.command(
  "$0",
  false, // hidden from help
  () => {},
  async (argv) => {
    // Reject unknown commands — $0 is the sole handler to avoid duplicate help output
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

// Intercept --help / -h before parse to show categorized help
const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  showCategorizedHelp();
} else {
  cli.parse();
}

// Profile report fires after yargs completes
process.on("exit", () => {
  printProfileReport();
});
