import { parse } from "smol-toml";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SynthConfig } from "../config/types.js";
import { spawn } from "../utils/process.js";
import { fileExists, readText } from "../utils/fs.js";
import { getPlatform } from "../platform/index.js";

export interface DoctorCheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message?: string;
  suggestion?: string;
}

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

  // Check if we're in a git repo
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

async function checkClaudeAuth(): Promise<DoctorCheckResult> {
  // Claude Code stores credentials in ~/.claude/ — check for auth by running a lightweight probe
  try {
    const result = await spawn({ cmd: ["claude", "-p", "test", "--max-turns", "0"], timeout: 15_000 }).promise;
    // Exit code 0 or non-auth errors mean auth is working
    const stderr = result.stderr.toLowerCase();
    if (stderr.includes("not authenticated") || stderr.includes("auth") || stderr.includes("api key") || stderr.includes("unauthorized")) {
      return { name: "claude auth", status: "fail", message: "not authenticated", suggestion: "run: claude login" };
    }
    return { name: "claude auth", status: "pass" };
  } catch {
    // If the probe times out or crashes, check for credential files as fallback
    const credPath = join(homedir(), ".claude", "credentials.json");
    if (await fileExists(credPath)) {
      return { name: "claude auth", status: "pass", message: "credentials file found" };
    }
    return { name: "claude auth", status: "warn", message: "could not verify authentication", suggestion: "run: claude login" };
  }
}

async function checkCodexAuth(): Promise<DoctorCheckResult> {
  // Codex requires OPENAI_API_KEY environment variable
  if (process.env.OPENAI_API_KEY) {
    return { name: "codex auth", status: "pass", message: "OPENAI_API_KEY set" };
  }
  return { name: "codex auth", status: "fail", message: "OPENAI_API_KEY not set", suggestion: "set OPENAI_API_KEY environment variable" };
}

async function checkAgentClis(): Promise<{ results: DoctorCheckResult[]; hasAgent: boolean }> {
  const results: DoctorCheckResult[] = [];
  let hasAgent = false;

  const claude = await checkCommand("claude", ["--version"]);
  if (claude.available) {
    hasAgent = true;
    results.push({ name: "claude CLI", status: "pass", message: claude.version });
    results.push(await checkClaudeAuth());
  } else {
    results.push({ name: "claude CLI", status: "warn", message: "not found", suggestion: "install with: npm install -g @anthropic-ai/claude-code" });
  }

  const codex = await checkCommand("codex", ["--version"]);
  if (codex.available) {
    hasAgent = true;
    results.push({ name: "codex CLI", status: "pass", message: codex.version });
    results.push(await checkCodexAuth());
  } else {
    results.push({ name: "codex CLI", status: "warn", message: "not found", suggestion: "install with: npm install -g @openai/codex" });
  }

  if (!hasAgent) {
    // Override warnings to failures when neither is present
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
  const results: DoctorCheckResult[] = [];

  results.push(await checkBun());
  results.push(...await checkGit(cwd));
  const agentResults = await checkAgentClis();
  results.push(...agentResults.results);

  const ghResult = await checkGh(config);
  if (ghResult) results.push(ghResult);

  results.push(await checkConfigFile(cwd));
  results.push(...await checkBackpressure(config));

  return results;
}
