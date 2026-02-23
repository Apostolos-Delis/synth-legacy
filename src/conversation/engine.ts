import type { AgentAdapter } from "../agents/types.js";
import type { ConversationMessage } from "./types.js";

export interface ConversationEngineConfig {
  agent: AgentAdapter;
  cwd: string;
  model?: string;
  systemPrompt: string;
  promptSuffix?: string;
  maxHistoryWindow?: number;
  persist?: (messages: ConversationMessage[]) => void | Promise<void>;
}

export class ConversationEngine {
  private messages: ConversationMessage[] = [];
  private readonly agent: AgentAdapter;
  private readonly cwd: string;
  private readonly model?: string;
  private readonly systemPrompt: string;
  private readonly promptSuffix: string;
  private readonly maxHistoryWindow: number;
  private readonly persist?: (messages: ConversationMessage[]) => void | Promise<void>;

  constructor(config: ConversationEngineConfig) {
    this.agent = config.agent;
    this.cwd = config.cwd;
    this.model = config.model;
    this.systemPrompt = config.systemPrompt;
    this.promptSuffix = config.promptSuffix ?? "";
    this.maxHistoryWindow = config.maxHistoryWindow ?? 16;
    this.persist = config.persist;
  }

  async send(userMessage: string, onChunk?: (chunk: string) => void): Promise<string> {
    this.messages.push({ role: "user", content: userMessage });

    const prompt = this.buildPrompt();
    const response = await this.sendToAgent(prompt, onChunk);
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
    const recentHistory = this.messages.slice(-this.maxHistoryWindow);
    const truncated = this.messages.length > this.maxHistoryWindow;

    const turns = recentHistory
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    const prefix = truncated
      ? `${this.systemPrompt}\n\n[Earlier conversation truncated — ${this.messages.length - this.maxHistoryWindow} messages omitted]\n\nRecent conversation:\n\n`
      : `${this.systemPrompt}\n\nConversation so far:\n\n`;

    const suffix = this.promptSuffix ? `\n\n${this.promptSuffix}` : "";

    return `${prefix}${turns}${suffix}`;
  }

  private async sendToAgent(prompt: string, onChunk?: (chunk: string) => void): Promise<string> {
    let output = "";
    const handle = this.agent.execute(prompt, {
      cwd: this.cwd,
      model: this.model,
      skipPermissions: false,
      onStdout: (chunk) => {
        output += chunk;
        onChunk?.(chunk);
      },
    });
    await handle.promise;
    return output;
  }
}
