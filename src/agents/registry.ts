import type { AgentAdapter } from "./types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";

export function getAgent(name: string): AgentAdapter {
  switch (name) {
    case "claude":
      return new ClaudeAdapter();
    case "codex":
      return new CodexAdapter();
    default:
      throw new Error(`Unknown agent: ${name}. Supported: claude, codex`);
  }
}
