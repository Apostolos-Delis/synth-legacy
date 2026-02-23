import { spawn } from "./process.js";

export async function getCurrentBranch(cwd: string): Promise<string> {
  const handle = spawn({
    cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    cwd,
  });
  const result = await handle.promise;
  if (result.exitCode !== 0) {
    throw new Error(`Failed to detect current branch: ${result.stderr}`);
  }
  return result.stdout.trim();
}
