import type { AgentExecuteOptions } from "./types.js";
import type { DoctorCheckResult } from "../doctor/types.js";
import { BaseAgentAdapter } from "./base.js";

export function buildCodexCmd(prompt: string, options: Pick<AgentExecuteOptions, "readOnly">): string[] {
  return [
    "codex",
    "--quiet",
    "--approval-mode",
    "full-auto",
    ...(options.readOnly ? ["--sandbox", "read-only"] : []),
    prompt,
  ];
}

export class CodexAdapter extends BaseAgentAdapter {
  readonly name = "codex";

  override get installHint() {
    return "install with: npm install -g @openai/codex";
  }

  protected buildCmd(prompt: string, options: AgentExecuteOptions): string[] {
    return buildCodexCmd(prompt, options);
  }

  override async checkAuth(): Promise<DoctorCheckResult | null> {
    if (process.env.OPENAI_API_KEY) {
      return { name: "codex auth", status: "pass", message: "OPENAI_API_KEY set" };
    }
    return { name: "codex auth", status: "fail", message: "OPENAI_API_KEY not set", suggestion: "set OPENAI_API_KEY environment variable" };
  }
}
