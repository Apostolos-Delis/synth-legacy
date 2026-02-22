import { describe, test, expect } from "bun:test";
import { getAgent } from "../agents/registry.js";
import { ClaudeAdapter } from "../agents/claude.js";
import { CodexAdapter } from "../agents/codex.js";

describe("getAgent", () => {
  test("returns ClaudeAdapter for 'claude'", () => {
    const agent = getAgent("claude");
    expect(agent).toBeInstanceOf(ClaudeAdapter);
    expect(agent.name).toBe("claude");
  });

  test("returns CodexAdapter for 'codex'", () => {
    const agent = getAgent("codex");
    expect(agent).toBeInstanceOf(CodexAdapter);
    expect(agent.name).toBe("codex");
  });

  test("throws for unknown agent name", () => {
    expect(() => getAgent("gpt")).toThrow("Unknown agent");
  });

  test("thrown error message includes available agents", () => {
    try {
      getAgent("nonexistent");
    } catch (e: unknown) {
      expect((e as Error).message).toContain("claude");
      expect((e as Error).message).toContain("codex");
      return;
    }
    throw new Error("Expected getAgent to throw");
  });
});
