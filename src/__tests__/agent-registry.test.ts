import { describe, test, expect } from "bun:test";
import { getAgent, getRegisteredAgentNames, createRegisteredAgents, registerAgent } from "../agents/registry.js";
import { ClaudeAdapter } from "../agents/claude.js";
import { CodexAdapter } from "../agents/codex.js";
import { BaseAgentAdapter } from "../agents/base.js";
import type { AgentExecuteOptions } from "../agents/types.js";

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

describe("getRegisteredAgentNames", () => {
  test("returns array containing claude and codex", () => {
    const names = getRegisteredAgentNames();
    expect(names).toContain("claude");
    expect(names).toContain("codex");
  });
});

describe("createRegisteredAgents", () => {
  test("returns adapter instances for all registered agents", () => {
    const agents = createRegisteredAgents();
    expect(agents.length).toBeGreaterThanOrEqual(2);
    const names = agents.map((a) => a.name);
    expect(names).toContain("claude");
    expect(names).toContain("codex");
  });

  test("all returned agents are instances of BaseAgentAdapter", () => {
    const agents = createRegisteredAgents();
    for (const agent of agents) {
      expect(agent).toBeInstanceOf(BaseAgentAdapter);
    }
  });
});

describe("registerAgent", () => {
  test("registers a new agent that can be retrieved", () => {
    class TestAdapter extends BaseAgentAdapter {
      readonly name = "test-register";
      protected buildCmd(_prompt: string, _options: AgentExecuteOptions): string[] {
        return ["test"];
      }
    }
    registerAgent("test-register", TestAdapter);
    const agent = getAgent("test-register");
    expect(agent).toBeInstanceOf(TestAdapter);
    expect(agent.name).toBe("test-register");
  });

  test("throws when registering a duplicate name", () => {
    expect(() => registerAgent("claude", ClaudeAdapter)).toThrow('Agent "claude" is already registered');
  });
});

describe("BaseAgentAdapter defaults", () => {
  class MinimalAdapter extends BaseAgentAdapter {
    readonly name = "minimal";
    protected buildCmd(_prompt: string, _options: AgentExecuteOptions): string[] {
      return ["minimal", "run"];
    }
  }

  test("cliCommand defaults to name", () => {
    const adapter = new MinimalAdapter();
    expect(adapter.cliCommand).toBe("minimal");
  });

  test("installHint returns npm install pattern", () => {
    const adapter = new MinimalAdapter();
    expect(adapter.installHint).toBe("install with: npm install -g minimal");
  });

  test("checkAuth returns null by default", async () => {
    const adapter = new MinimalAdapter();
    expect(await adapter.checkAuth()).toBeNull();
  });

  test("dispose is safe when no handle is active", () => {
    const adapter = new MinimalAdapter();
    expect(() => adapter.dispose()).not.toThrow();
  });

  test("detect returns unavailable for nonexistent command", async () => {
    const adapter = new MinimalAdapter();
    const result = await adapter.detect();
    expect(result.available).toBe(false);
    expect(result.error).toContain("minimal");
  });
});
