import type { AgentAdapter, AgentExecuteOptions } from "../agents/types.js";
import type { SynthConfig } from "../config/types.js";
import type { PlanPaths } from "../plans/types.js";
import type {
  FinalizePhase,
  FinalizeMessage,
  ChatOption,
  FixTask,
} from "./chat-types.js";
import {
  buildAuditContext,
  buildAuditSystemPrompt,
  buildInitialAuditPrompt,
} from "./audit-chat.js";

const MAX_HISTORY = 20;
const OPTION_RE = /\[OPTION\]([^|]+)\|([^[]+)\[\/OPTION\]/g;
const REVIEW_COMPLETE_RE = /\[REVIEW_COMPLETE\]/;
const PROCEED_COMMANDS = new Set(["proceed", "done"]);

export interface ParsedResponse {
  content: string;
  options: ChatOption[];
  reviewComplete: boolean;
}

export function parseAIResponse(raw: string): ParsedResponse {
  const options: ChatOption[] = [];

  for (const match of raw.matchAll(OPTION_RE)) {
    const label = match[1].trim();
    const description = match[2].trim();
    options.push({
      label,
      description,
      value: label.toLowerCase().replace(/\s+/g, "-"),
    });
  }

  const reviewComplete = REVIEW_COMPLETE_RE.test(raw);

  // Strip markers from displayed content
  let content = raw
    .replace(OPTION_RE, "")
    .replace(REVIEW_COMPLETE_RE, "")
    .trim();

  // Collapse leftover blank lines from stripped markers
  content = content.replace(/\n{3,}/g, "\n\n");

  return { content, options, reviewComplete };
}

export type PhaseChangeListener = (phase: FinalizePhase) => void;

export interface OrchestratorResponse {
  message: FinalizeMessage;
}

export class FinalizeOrchestrator {
  private phase: FinalizePhase = "auditing";
  private messages: FinalizeMessage[] = [];
  private fixes: FixTask[] = [];
  private systemPrompt = "";
  private cwd = "";
  private model?: string;
  private phaseListeners: PhaseChangeListener[] = [];

  getCurrentPhase(): FinalizePhase {
    return this.phase;
  }

  getCollectedFixes(): FixTask[] {
    return [...this.fixes];
  }

  getMessages(): FinalizeMessage[] {
    return [...this.messages];
  }

  onPhaseChange(listener: PhaseChangeListener): () => void {
    this.phaseListeners.push(listener);
    return () => {
      this.phaseListeners = this.phaseListeners.filter((l) => l !== listener);
    };
  }

  private setPhase(phase: FinalizePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    for (const listener of this.phaseListeners) {
      listener(phase);
    }
  }

  async start(
    agent: AgentAdapter,
    config: SynthConfig,
    planPaths: PlanPaths,
    cwd: string,
    onChunk?: (chunk: string) => void,
  ): Promise<OrchestratorResponse> {
    this.cwd = cwd;
    this.model = config.agent.model;
    this.systemPrompt = buildAuditSystemPrompt();
    this.setPhase("auditing");

    // Build the audit context from git diff + task file
    const auditContext = await buildAuditContext(
      planPaths,
      cwd,
      config.project.base_branch,
    );

    const userPrompt = buildInitialAuditPrompt(auditContext);

    // Send to AI and get the initial review
    const response = await this.sendToAgent(agent, userPrompt, onChunk);
    const parsed = parseAIResponse(response);

    const assistantMsg: FinalizeMessage = {
      role: "assistant",
      content: parsed.content,
      ...(parsed.options.length > 0 ? { options: parsed.options } : {}),
    };
    this.messages.push(assistantMsg);

    // Move to discussing phase after audit completes
    this.setPhase("discussing");

    return { message: assistantMsg };
  }

  async handleUserMessage(
    text: string,
    agent: AgentAdapter,
    onChunk?: (chunk: string) => void,
  ): Promise<OrchestratorResponse> {
    const userMsg: FinalizeMessage = { role: "user", content: text };
    this.messages.push(userMsg);

    switch (this.phase) {
      case "discussing":
        return this.handleDiscussing(agent, text, onChunk);
      case "collecting-fixes":
        return this.handleCollectingFixes(agent, text, onChunk);
      case "executing-fixes":
      case "creating-pr":
      case "complete":
        return this.handleGenericResponse(agent, text, onChunk);
      default:
        return this.handleGenericResponse(agent, text, onChunk);
    }
  }

  async handleOptionSelect(
    option: ChatOption,
    agent: AgentAdapter,
    onChunk?: (chunk: string) => void,
  ): Promise<OrchestratorResponse> {
    // Record the selection as a user message
    const userMsg: FinalizeMessage = {
      role: "user",
      content: `Selected: ${option.label}`,
    };
    this.messages.push(userMsg);

    if (this.phase === "discussing") {
      return this.handleDiscussionOption(agent, option, onChunk);
    }

    if (this.phase === "collecting-fixes") {
      return this.handleFixOption(agent, option, onChunk);
    }

    // Default: treat as a conversational message
    return this.handleGenericResponse(
      agent,
      `The user selected: "${option.label}" — ${option.description}`,
      onChunk,
    );
  }

  // ---------------------------------------------------------------------------
  // Phase handlers
  // ---------------------------------------------------------------------------

  private async handleDiscussing(
    agent: AgentAdapter,
    text: string,
    onChunk?: (chunk: string) => void,
  ): Promise<OrchestratorResponse> {
    // Check for user shortcut to skip remaining Q&A
    if (PROCEED_COMMANDS.has(text.trim().toLowerCase())) {
      this.setPhase("collecting-fixes");
      const assistantMsg: FinalizeMessage = {
        role: "assistant",
        content:
          "Understood — moving on to collect fixes. Let me summarize the issues found and recommend which ones to address.",
      };
      this.messages.push(assistantMsg);
      return { message: assistantMsg };
    }

    const prompt = this.buildConversationPrompt(
      `The user is in the discussion phase of a code review. They said:\n\n"${text}"\n\n` +
        `Continue the code review discussion by asking your next follow-up question on a single topic. ` +
        `If you want to offer choices, use [OPTION]label|description[/OPTION] markers (2-4 options). ` +
        `If you have no more concerns, end with [REVIEW_COMPLETE]. ` +
        `Ask one question at a time. Be concise.`,
    );

    const response = await this.sendToAgent(agent, prompt, onChunk);
    return this.processDiscussingResponse(response);
  }

  private async handleDiscussionOption(
    agent: AgentAdapter,
    option: ChatOption,
    onChunk?: (chunk: string) => void,
  ): Promise<OrchestratorResponse> {
    if (option.value === "collect-fixes" || option.value === "fix") {
      this.setPhase("collecting-fixes");
    }

    const prompt = this.buildConversationPrompt(
      `The user selected the option: "${option.label}" (${option.description}).\n\n` +
        `Respond based on their choice, then ask your next follow-up question on a single topic. ` +
        `If you want to offer choices, use [OPTION]label|description[/OPTION] markers (2-4 options). ` +
        `If you have no more concerns, end with [REVIEW_COMPLETE]. Be concise.`,
    );

    const response = await this.sendToAgent(agent, prompt, onChunk);

    // If we already transitioned to collecting-fixes, don't re-process for discussion
    if (this.phase === "collecting-fixes") {
      const parsed = parseAIResponse(response);
      const assistantMsg: FinalizeMessage = {
        role: "assistant",
        content: parsed.content,
        ...(parsed.options.length > 0 ? { options: parsed.options } : {}),
      };
      this.messages.push(assistantMsg);
      return { message: assistantMsg };
    }

    return this.processDiscussingResponse(response);
  }

  private processDiscussingResponse(response: string): OrchestratorResponse {
    const parsed = parseAIResponse(response);

    const assistantMsg: FinalizeMessage = {
      role: "assistant",
      content: parsed.content,
      ...(parsed.options.length > 0 ? { options: parsed.options } : {}),
    };
    this.messages.push(assistantMsg);

    // AI signalled review is complete — transition to collecting-fixes
    if (parsed.reviewComplete) {
      this.setPhase("collecting-fixes");
    }

    return { message: assistantMsg };
  }

  private async handleCollectingFixes(
    agent: AgentAdapter,
    text: string,
    onChunk?: (chunk: string) => void,
  ): Promise<OrchestratorResponse> {
    const prompt = this.buildConversationPrompt(
      `The user is selecting which fixes to apply. They said:\n\n"${text}"\n\n` +
        `Help them select fixes. If they've confirmed their selections, summarize ` +
        `the fix plan and ask for final confirmation before proceeding.`,
    );

    const response = await this.sendToAgent(agent, prompt, onChunk);

    const assistantMsg: FinalizeMessage = {
      role: "assistant",
      content: response,
    };
    this.messages.push(assistantMsg);

    return { message: assistantMsg };
  }

  private async handleFixOption(
    agent: AgentAdapter,
    option: ChatOption,
    onChunk?: (chunk: string) => void,
  ): Promise<OrchestratorResponse> {
    if (option.value === "execute-fixes" || option.value === "confirm") {
      this.setPhase("executing-fixes");
    }

    const prompt = this.buildConversationPrompt(
      `The user selected: "${option.label}" (${option.description}) during fix collection.\n\n` +
        `Respond appropriately. If they confirmed execution, acknowledge and describe ` +
        `what will happen next.`,
    );

    const response = await this.sendToAgent(agent, prompt, onChunk);

    const assistantMsg: FinalizeMessage = {
      role: "assistant",
      content: response,
    };
    this.messages.push(assistantMsg);

    return { message: assistantMsg };
  }

  private async handleGenericResponse(
    agent: AgentAdapter,
    text: string,
    onChunk?: (chunk: string) => void,
  ): Promise<OrchestratorResponse> {
    const prompt = this.buildConversationPrompt(
      `The user said:\n\n"${text}"\n\nRespond helpfully in the context of the code review.`,
    );

    const response = await this.sendToAgent(agent, prompt, onChunk);

    const assistantMsg: FinalizeMessage = {
      role: "assistant",
      content: response,
    };
    this.messages.push(assistantMsg);

    return { message: assistantMsg };
  }

  // ---------------------------------------------------------------------------
  // Fix tracking
  // ---------------------------------------------------------------------------

  addFix(fix: FixTask): void {
    this.fixes.push(fix);
  }

  removeFix(fixId: string): void {
    this.fixes = this.fixes.filter((f) => f.id !== fixId);
  }

  // ---------------------------------------------------------------------------
  // Prompt construction
  // ---------------------------------------------------------------------------

  private buildConversationPrompt(instruction: string): string {
    const recentMessages = this.messages.slice(-MAX_HISTORY);
    const truncated = this.messages.length > MAX_HISTORY;

    const history = recentMessages
      .map((m) => {
        const role =
          m.role === "user"
            ? "User"
            : m.role === "system"
              ? "System"
              : "Assistant";
        return `${role}: ${m.content}`;
      })
      .join("\n\n");

    const prefix = truncated
      ? `${this.systemPrompt}\n\n[Earlier conversation truncated — ${this.messages.length - MAX_HISTORY} messages omitted]\n\nRecent conversation:\n\n`
      : `${this.systemPrompt}\n\nConversation so far:\n\n`;

    return `${prefix}${history}\n\n---\n\n${instruction}`;
  }

  // ---------------------------------------------------------------------------
  // Agent communication
  // ---------------------------------------------------------------------------

  private async sendToAgent(
    agent: AgentAdapter,
    prompt: string,
    onChunk?: (chunk: string) => void,
  ): Promise<string> {
    let output = "";
    const options: AgentExecuteOptions = {
      cwd: this.cwd,
      model: this.model,
      skipPermissions: false,
      onStdout: (chunk) => {
        output += chunk;
        onChunk?.(chunk);
      },
    };

    const handle = agent.execute(prompt, options);
    await handle.promise;
    return output;
  }
}
