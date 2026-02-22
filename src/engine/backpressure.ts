import { spawn } from "../utils/process.js";

export interface BackpressureResult {
  passed: boolean;
  results: { command: string; exitCode: number; output: string }[];
}

export async function runBackpressure(
  commands: string[],
  cwd: string,
): Promise<BackpressureResult> {
  if (commands.length === 0) return { passed: true, results: [] };

  const results: BackpressureResult["results"] = [];
  let allPassed = true;

  for (const command of commands) {
    const parts = command.split(/\s+/);
    const handle = spawn({ cmd: parts, cwd });
    const result = await handle.promise;

    const passed = result.exitCode === 0;
    if (!passed) allPassed = false;

    results.push({
      command,
      exitCode: result.exitCode,
      output: (result.stdout + result.stderr).slice(0, 2000),
    });
  }

  return { passed: allPassed, results };
}
