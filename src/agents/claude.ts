import type { AgentExecuteOptions } from "./types.js";
import type { DoctorCheckResult } from "../doctor/types.js";
import { BaseAgentAdapter } from "./base.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileExists } from "../utils/fs.js";

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];

export function buildClaudeCmd(prompt: string, options: Pick<AgentExecuteOptions, "model" | "skipPermissions" | "readOnly">): string[] {
  return [
    "claude",
    "-p",
    prompt,
    ...(options.model ? ["--model", options.model] : []),
    ...(options.skipPermissions !== false ? ["--dangerously-skip-permissions"] : []),
    ...(options.readOnly ? ["--tools", READ_ONLY_TOOLS.join(",")] : []),
  ];
}

export class ClaudeAdapter extends BaseAgentAdapter {
  readonly name = "claude";

  override get installHint() {
    return "install with: npm install -g @anthropic-ai/claude-code";
  }

  protected buildCmd(prompt: string, options: AgentExecuteOptions): string[] {
    return buildClaudeCmd(prompt, options);
  }

  override async checkAuth(): Promise<DoctorCheckResult | null> {
    const credPath = join(homedir(), ".claude", "credentials.json");
    if (await fileExists(credPath)) {
      return { name: "claude auth", status: "pass", message: "credentials file found" };
    }
    return { name: "claude auth", status: "warn", message: "could not verify authentication", suggestion: "run: claude login" };
  }
}
