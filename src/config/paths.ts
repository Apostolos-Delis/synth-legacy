import { join } from "node:path";
import { homedir } from "node:os";

export function globalConfigDir(): string {
  return join(homedir(), ".synth");
}

export function globalConfigPath(): string {
  return join(globalConfigDir(), "config.toml");
}

export function setupSentinelPath(): string {
  return join(globalConfigDir(), ".setup-complete");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, "synth.toml");
}
