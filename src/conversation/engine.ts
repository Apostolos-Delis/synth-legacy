import type { AgentAdapter, AgentToolEvent } from "../agents/types.js";
import type { ConversationMessage } from "./types.js";
import { getLogger } from "../logging/logger.js";

const TOOL_INPUT_LIMIT = 600;
const TOOL_OUTPUT_LIMIT = 1200;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

function toDisplay(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface ConversationEngineConfig {
  agent: AgentAdapter;
  cwd: string;
  model?: string;
  readOnly?: boolean;
  systemPrompt: string;
  promptSuffix?: string;
  persist?: (messages: ConversationMessage[]) => void | Promise<void>;
}

export class ConversationEngine {
  private messages: ConversationMessage[] = [];
  private readonly agent: AgentAdapter;
  private readonly cwd: string;
  private readonly model?: string;
  private readonly readOnly: boolean;
  private systemPrompt: string;
  private readonly promptSuffix: string;
  private readonly persist?: (messages: ConversationMessage[]) => void | Promise<void>;

  constructor(config: ConversationEngineConfig) {
    this.agent = config.agent;
    this.cwd = config.cwd;
    this.model = config.model;
    this.readOnly = config.readOnly ?? false;
    this.systemPrompt = config.systemPrompt;
    this.promptSuffix = config.promptSuffix ?? "";
    this.persist = config.persist;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  async send(userMessage: string, onChunk?: (chunk: string) => void, onTool?: (event: AgentToolEvent) => void): Promise<string> {
    this.messages.push({ role: "user", content: userMessage });

    const prompt = this.buildPrompt();
    const response = await this.sendToAgent(prompt, onChunk, onTool);
    this.messages.push({ role: "assistant", content: response });

    await this.persist?.(this.getHistory());

    return response;
  }

  getHistory(): ConversationMessage[] {
    return [...this.messages];
  }

  restoreHistory(messages: ConversationMessage[]): void {
    this.messages = [...messages];
  }

  private buildPrompt(): string {
    const turns = this.messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    const prefix = `${this.systemPrompt}\n\nConversation so far:\n\n`;
    const suffix = this.promptSuffix ? `\n\n${this.promptSuffix}` : "";

    return `${prefix}${turns}${suffix}`;
  }

  private async sendToAgent(prompt: string, onChunk?: (chunk: string) => void, onTool?: (event: AgentToolEvent) => void): Promise<string> {
    const logger = getLogger();
    const startedAt = Date.now();
    let toolUseCount = 0;
    let toolResultCount = 0;

    logger.info("agent:request", "Agent request started", {
      agent: this.agent.name,
      model: this.model,
      readOnly: this.readOnly,
      promptLength: prompt.length,
      messageCount: this.messages.length,
    });

    const handle = this.agent.execute(prompt, {
      cwd: this.cwd,
      model: this.model,
      readOnly: this.readOnly,
      skipPermissions: false,
      onStdout: (chunk) => {
        onChunk?.(chunk);
      },
      onTool: (event) => {
        if (event.kind === "use") toolUseCount += 1;
        if (event.kind === "result") toolResultCount += 1;
        const input = event.input !== undefined ? truncate(toDisplay(event.input), TOOL_INPUT_LIMIT) : undefined;
        const output = event.output !== undefined ? truncate(toDisplay(event.output), TOOL_OUTPUT_LIMIT) : undefined;
        logger.debug("agent:tool", "Agent tool event", {
          kind: event.kind,
          name: event.name,
          id: event.id,
          ...(input !== undefined ? { input } : {}),
          ...(output !== undefined ? { output } : {}),
        });
        onTool?.(event);
      },
    });
    const result = await handle.promise;
    const durationMs = Date.now() - startedAt;

    logger.info("agent:response", "Agent response complete", {
      agent: this.agent.name,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
      firstTokenMs: result.firstTokenMs ?? null,
      toolUseCount,
      toolResultCount,
    });
    if (result.timedOut) {
      logger.error("agent:timeout", "Agent execution timed out", {
        agent: this.agent.name,
        durationMs,
      });
      throw new Error("Agent execution timed out");
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr ? truncate(result.stderr, 2000) : "";
      logger.error("agent:exit", "Agent exited non-zero", {
        agent: this.agent.name,
        exitCode: result.exitCode,
        stderr,
      });
      throw new Error(`Agent exited with code ${result.exitCode}: ${result.stderr}`);
    }
    if (!result.stdout.trim()) {
      if (this.agent.name === "claude") {
        getLogger().error("agent:empty-response", "Agent returned empty response", {
          agent: this.agent.name,
          rawStdout: result.rawStdout ?? result.stdout,
          stderr: result.stderr,
        });
      }
      throw new Error("Agent returned empty response");
    }
    return result.stdout;
  }
}
