import { parse } from "smol-toml";
import { join } from "node:path";
import type { SynthConfig } from "../config/types.js";
import { spawn } from "../utils/process.js";
import { fileExists, readText } from "../utils/fs.js";
import { getPlatform } from "../platform/index.js";
import { globalConfigPath } from "../config/paths.js";
import { createRegisteredAgents } from "../agents/registry.js";

import type { DoctorCheckResult } from "./types.js";
export type { DoctorCheckResult } from "./types.js";

export async function checkCommand(cmd: string, versionArgs: string[]): Promise<{ available: boolean; version: string; error: string }> {
  try {
    const result = await spawn({ cmd: [cmd, ...versionArgs], timeout: 10_000 }).promise;
    if (result.exitCode === 0) {
      return { available: true, version: result.stdout.trim().split("\n")[0], error: "" };
    }
    return { available: false, version: "", error: result.stderr.trim() || `exit code ${result.exitCode}` };
  } catch {
    return { available: false, version: "", error: `${cmd} not found in PATH` };
  }
}

export function parseVersion(versionStr: string): number[] {
  const match = versionStr.match(/(\d+)\.(\d+)\.?(\d+)?/);
  if (!match) return [0, 0, 0];
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3] ?? "0", 10)];
}

async function checkBun(): Promise<DoctorCheckResult> {
  const result = await checkCommand("bun", ["--version"]);
  if (!result.available) {
    return { name: "bun", status: "fail", message: result.error, suggestion: "install with: curl -fsSL https://bun.sh/install | bash" };
  }
  const [major] = parseVersion(result.version);
  if (major < 1) {
    return { name: "bun", status: "fail", message: `version ${result.version} is below minimum 1.0`, suggestion: "upgrade with: bun upgrade" };
  }
  return { name: "bun", status: "pass", message: result.version };
}

async function checkGit(cwd: string): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = [];
  const gitResult = await checkCommand("git", ["--version"]);
  if (!gitResult.available) {
    results.push({ name: "git", status: "fail", message: gitResult.error, suggestion: "install git: https://git-scm.com/downloads" });
    return results;
  }
  results.push({ name: "git", status: "pass", message: gitResult.version });

  try {
    const repoResult = await spawn({ cmd: ["git", "rev-parse", "--is-inside-work-tree"], cwd, timeout: 5_000 }).promise;
    if (repoResult.exitCode !== 0) {
      results.push({ name: "git repo", status: "warn", message: "not inside a git repository", suggestion: "run: git init" });
    } else {
      results.push({ name: "git repo", status: "pass" });
    }
  } catch {
    results.push({ name: "git repo", status: "warn", message: "could not determine git status" });
  }

  return results;
}

async function checkAgentClis(): Promise<{ results: DoctorCheckResult[]; hasAgent: boolean }> {
  const results: DoctorCheckResult[] = [];
  let hasAgent = false;

  for (const agent of createRegisteredAgents()) {
    const detection = await agent.detect();

    if (detection.available) {
      hasAgent = true;
      results.push({ name: `${agent.name} CLI`, status: "pass", message: detection.version });
      const authResult = await agent.checkAuth();
      if (authResult) results.push(authResult);
    } else {
      results.push({ name: `${agent.name} CLI`, status: "warn", message: "not found", suggestion: agent.installHint });
    }
  }

  if (!hasAgent) {
    for (const r of results) {
      if (r.name.endsWith("CLI")) r.status = "fail";
    }
  }

  return { results, hasAgent };
}

async function checkGh(config?: SynthConfig): Promise<DoctorCheckResult | null> {
  if (!config?.finalize?.create_pr) return null;
  const result = await checkCommand("gh", ["--version"]);
  if (!result.available) {
    return { name: "gh CLI", status: "fail", message: "required for PR creation", suggestion: `install with: ${getPlatform().installHint("gh")} && gh auth login` };
  }
  return { name: "gh CLI", status: "pass", message: result.version };
}

async function checkConfigFile(cwd: string): Promise<DoctorCheckResult> {
  const configPath = join(cwd, "synth.toml");
  if (!(await fileExists(configPath))) {
    return { name: "synth.toml", status: "warn", message: "config file not found", suggestion: "run: synth init" };
  }

  try {
    const content = await readText(configPath);
    parse(content);
    return { name: "synth.toml", status: "pass", message: "valid" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: "synth.toml", status: "fail", message: `parse error: ${message}`, suggestion: "fix the TOML syntax in synth.toml" };
  }
}

async function checkGlobalConfigFile(): Promise<DoctorCheckResult> {
  const gp = globalConfigPath();
  if (!(await fileExists(gp))) {
    return { name: "~/.synth/config.toml", status: "pass", message: "not present (optional)" };
  }
  try {
    const content = await readText(gp);
    parse(content);
    return { name: "~/.synth/config.toml", status: "pass", message: "valid" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: "~/.synth/config.toml", status: "fail", message: `parse error: ${message}`, suggestion: "fix the TOML syntax in ~/.synth/config.toml" };
  }
}

async function checkBackpressure(config?: SynthConfig): Promise<DoctorCheckResult[]> {
  if (!config?.guardrails?.backpressure_commands?.length) return [];
  const results: DoctorCheckResult[] = [];

  for (const cmd of config.guardrails.backpressure_commands) {
    const binary = cmd.split(/\s+/)[0];
    const check = await checkCommand(binary, ["--version"]);
    if (check.available) {
      results.push({ name: `backpressure: ${binary}`, status: "pass" });
    } else {
      results.push({ name: `backpressure: ${binary}`, status: "warn", message: `${binary} not found`, suggestion: `ensure '${binary}' is installed and in PATH` });
    }
  }

  return results;
}

export async function runDoctorChecks(cwd: string, config?: SynthConfig): Promise<DoctorCheckResult[]> {
  const [
    bunResult,
    gitResults,
    agentResults,
    ghResult,
    configResult,
    globalConfigResult,
    backpressureResults,
  ] = await Promise.all([
    checkBun(),
    checkGit(cwd),
    checkAgentClis(),
    checkGh(config),
    checkConfigFile(cwd),
    checkGlobalConfigFile(),
    checkBackpressure(config),
  ]);

  const results: DoctorCheckResult[] = [];
  results.push(bunResult);
  results.push(...gitResults);
  results.push(...agentResults.results);
  if (ghResult) results.push(ghResult);
  results.push(configResult);
  results.push(globalConfigResult);
  results.push(...backpressureResults);

  return results;
}
