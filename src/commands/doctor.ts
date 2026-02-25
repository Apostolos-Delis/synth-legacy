import { loadConfig } from "../config/loader.js";
import type { DoctorCheckResult } from "../doctor/doctor.js";
import { ansi } from "../tui/theme.js";

import type { Argv } from "yargs";

interface CommandModule {
  command: string;
  describe: string;
  builder: (yargs: Argv) => Argv;
  handler: () => void | Promise<void>;
}

const doctorCommand: CommandModule = {
  command: "doctor",
  describe: "Validate environment setup and dependencies",
  builder: (yargs) =>
    yargs.example("synth doctor", "Validate environment setup and dependencies"),
  handler: async () => {
    const cwd = process.cwd();
    const { runDoctorChecks } = await import("../doctor/doctor.js");
    let config;
    try {
      config = await loadConfig(cwd);
    } catch {
      // Config may be invalid — doctor will report it
    }

    console.log(`${ansi.bold}synth doctor${ansi.reset}\n`);
    const results: DoctorCheckResult[] = await runDoctorChecks(cwd, config);
    const passed = results.filter((r) => r.status === "pass").length;
    const failed = results.filter((r) => r.status === "fail").length;

    for (const r of results) {
      if (r.status === "pass") {
        console.log(`  ${ansi.success}✓${ansi.reset} ${r.name}${r.message ? ` ${ansi.muted}(${r.message})${ansi.reset}` : ""}`);
      } else if (r.status === "fail") {
        console.log(`  ${ansi.error}✗${ansi.reset} ${r.name}: ${r.message ?? "failed"}`);
        if (r.suggestion) console.log(`    ${ansi.muted}→ ${r.suggestion}${ansi.reset}`);
      } else {
        console.log(`  ${ansi.warning}⚠${ansi.reset} ${r.name}: ${r.message ?? "warning"}`);
        if (r.suggestion) console.log(`    ${ansi.muted}→ ${r.suggestion}${ansi.reset}`);
      }
    }

    const summaryColor = failed > 0 ? ansi.error : ansi.success;
    console.log(`\n${summaryColor}${passed}/${results.length} checks passed${ansi.reset}`);

    if (failed > 0) process.exit(1);
  },
};

export default doctorCommand;
