import type { AgentAdapter } from "./types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";

export type AdapterConstructor = new () => AgentAdapter;

const registry: Record<string, AdapterConstructor> = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
};

export function getAgent(name: string): AgentAdapter {
  const Ctor = registry[name];
  if (!Ctor) {
    throw new Error(`Unknown agent: ${name}. Supported: ${getRegisteredAgentNames().join(", ")}`);
  }
  return new Ctor();
}

export function createRegisteredAgents(): AgentAdapter[] {
  return Object.values(registry).map((Ctor) => new Ctor());
}

export function getRegisteredAgentNames(): string[] {
  return Object.keys(registry);
}

export function registerAgent(name: string, ctor: AdapterConstructor): void {
  if (registry[name]) {
    throw new Error(`Agent "${name}" is already registered`);
  }
  registry[name] = ctor;
}
