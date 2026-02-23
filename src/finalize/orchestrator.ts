import type { AgentAdapter, AgentExecuteOptions } from "../agents/types.js";
import type { SynthConfig } from "../config/types.js";
import type { PlanPaths } from "../plans/types.js";
import type {
  FinalizePhase,
  FinalizeMessage,
  ChatOption,
  FixTask,
  FixTaskStatus,
} from "./chat-types.js";
import {
  buildAuditContext,
  buildAuditSystemPrompt,
  buildInitialAuditPrompt,
} from "./audit-chat.js";

const MAX_HISTORY = 20;
const OPTION_RE = /\[OPTION\]([^|]+)\|([^[]+)\[\/OPTION\]/g;
const FIX_RE = /\[FIX\]([\s\S]*?)\[\/FIX\]/g;
const REVIEW_COMPLETE_RE = /\[REVIEW_COMPLETE\]/;
const PROCEED_COMMANDS = new Set(["proceed", "done"]);

export interface ParsedResponse {
  content: string;
  options: ChatOption[];
  fixDescriptions: string[];
  reviewComplete: boolean;
}

export function parseAIResponse(raw: string): ParsedResponse {
  const options: ChatOption[] = [];
  const fixDescriptions: string[] = [];

  for (const match of raw.matchAll(OPTION_RE)) {
    const label = match[1].trim();
    const description = match[2].trim();
    options.push({
      label,
      description,
      value: label.toLowerCase().replace(/\s+/g, "-"),
    });
  }

  for (const match of raw.matchAll(FIX_RE)) {
    const desc = match[1].trim();
    if (desc) fixDescriptions.push(desc);
  }

  const reviewComplete = REVIEW_COMPLETE_RE.test(raw);

  // Strip markers from displayed content
  let content = raw
    .replace(OPTION_RE, "")
    .replace(FIX_RE, "")
    .replace(REVIEW_COMPLETE_RE, "")
    .trim();

  // Collapse leftover blank lines from stripped markers
  content = content.replace(/\n{3,}/g, "\n\n");

  return { content, options, fixDescriptions, reviewComplete };
}

export type PhaseChangeListener = (phase: FinalizePhase) => void;

export interface OrchestratorResponse {
  message: FinalizeMessage;
}

export class FinalizeOrchestrator {
  private phase: FinalizePhase = "auditing";
  private messages: FinalizeMessage[] = [];
  private fixes: FixTask[] = [];
  private confirmedFixes: FixTask[] = [];
  private fixCounter = 0;
  private reviewIndex = 0;
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

  getConfirmedFixes(): FixTask[] {
    return [...this.confirmedFixes];
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

    // Extract any fix proposals from the initial audit
    this.extractFixesFromParsed(parsed);

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
      return this.transitionToCollectingFixes();
    }

    const prompt = this.buildConversationPrompt(
      `The user is in the discussion phase of a code review. They said:\n\n"${text}"\n\n` +
        `Continue the code review discussion by asking your next follow-up question on a single topic. ` +
        `If you want to offer choices, use [OPTION]label|description[/OPTION] markers (2-4 options). ` +
        `If you want to propose a fix, use [FIX]description of fix[/FIX] markers. ` +
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
      return this.transitionToCollectingFixes();
    }

    const prompt = this.buildConversationPrompt(
      `The user selected the option: "${option.label}" (${option.description}).\n\n` +
        `Respond based on their choice, then ask your next follow-up question on a single topic. ` +
        `If you want to offer choices, use [OPTION]label|description[/OPTION] markers (2-4 options). ` +
        `If you want to propose a fix, use [FIX]description of fix[/FIX] markers. ` +
        `If you have no more concerns, end with [REVIEW_COMPLETE]. Be concise.`,
    );

    const response = await this.sendToAgent(agent, prompt, onChunk);
    return this.processDiscussingResponse(response);
  }

  private processDiscussingResponse(response: string): OrchestratorResponse {
    const parsed = parseAIResponse(response);

    // Extract any [FIX] markers from the AI response
    this.extractFixesFromParsed(parsed);

    const assistantMsg: FinalizeMessage = {
      role: "assistant",
      content: parsed.content,
      ...(parsed.options.length > 0 ? { options: parsed.options } : {}),
    };
    this.messages.push(assistantMsg);

    // AI signalled review is complete — transition to collecting-fixes
    if (parsed.reviewComplete) {
      return this.transitionToCollectingFixes();
    }

    return { message: assistantMsg };
  }

  private transitionToCollectingFixes(): OrchestratorResponse {
    this.setPhase("collecting-fixes");

    // No fixes proposed — skip directly to PR creation
    if (this.fixes.length === 0) {
      this.setPhase("creating-pr");
      const skipMsg: FinalizeMessage = {
        role: "assistant",
        content: "No fixes were identified during the review. Moving on to PR creation.",
      };
      this.messages.push(skipMsg);
      return { message: skipMsg };
    }

    // Present the collected fixes with options
    const fixListMsg = this.buildFixListMessage();
    this.messages.push(fixListMsg);
    return { message: fixListMsg };
  }

  private async handleCollectingFixes(
    _agent: AgentAdapter,
    text: string,
    _onChunk?: (chunk: string) => void,
  ): Promise<OrchestratorResponse> {
    // Check if we're in modify mode for the current review fix
    if (
      this.reviewIndex < this.fixes.length &&
      this.fixes[this.reviewIndex].status === "modified"
    ) {
      this.fixes[this.reviewIndex].description = text;
      this.fixes[this.reviewIndex].acceptanceCriteria = [`Fix applied: ${text}`];
      this.fixes[this.reviewIndex].status = "accepted";
      this.confirmedFixes.push({ ...this.fixes[this.reviewIndex] });
      return this.advanceIndividualReview();
    }

    // User typed a custom fix description in freeform
    this.fixCounter++;
    const customFix: FixTask = {
      id: `FIX-${String(this.fixCounter).padStart(3, "0")}`,
      description: text,
      acceptanceCriteria: [`Fix applied: ${text}`],
      priority: 2,
      status: "proposed",
      sourceIssue: {
        severity: "major",
        category: "custom",
        description: text,
      },
    };
    this.fixes.push(customFix);

    // Re-present the full list with options
    const fixListMsg = this.buildFixListMessage();
    this.messages.push(fixListMsg);
    return { message: fixListMsg };
  }

  private async handleFixOption(
    _agent: AgentAdapter,
    option: ChatOption,
    _onChunk?: (chunk: string) => void,
  ): Promise<OrchestratorResponse> {
    switch (option.value) {
      case "accept-all": {
        this.confirmedFixes = this.fixes.map((f) => ({ ...f, status: "accepted" as FixTaskStatus }));
        this.setPhase("executing-fixes");
        const msg: FinalizeMessage = {
          role: "assistant",
          content: `All ${this.confirmedFixes.length} fixes accepted. Moving to execution phase.`,
        };
        this.messages.push(msg);
        return { message: msg };
      }

      case "review-individually": {
        this.reviewIndex = 0;
        this.confirmedFixes = [];
        const reviewMsg = this.buildIndividualReviewMessage();
        this.messages.push(reviewMsg);
        return { message: reviewMsg };
      }

      case "skip-fixes": {
        this.confirmedFixes = [];
        this.setPhase("creating-pr");
        const skipMsg: FinalizeMessage = {
          role: "assistant",
          content: "Skipping all fixes. Moving on to PR creation.",
        };
        this.messages.push(skipMsg);
        return { message: skipMsg };
      }

      case "add-custom-fix": {
        const promptMsg: FinalizeMessage = {
          role: "assistant",
          content: "Describe the fix you'd like to add:",
        };
        this.messages.push(promptMsg);
        return { message: promptMsg };
      }

      case "accept-fix": {
        const accepted = { ...this.fixes[this.reviewIndex], status: "accepted" as FixTaskStatus };
        this.confirmedFixes.push(accepted);
        return this.advanceIndividualReview();
      }

      case "reject-fix": {
        // Mark as rejected but don't add to confirmedFixes
        this.fixes[this.reviewIndex].status = "rejected";
        return this.advanceIndividualReview();
      }

      case "modify-fix": {
        const modifyMsg: FinalizeMessage = {
          role: "assistant",
          content: `Current: ${this.fixes[this.reviewIndex].description}\n\nType the updated description:`,
        };
        this.messages.push(modifyMsg);
        // Stay in collecting-fixes, next freeform text will be handled as modification
        this.fixes[this.reviewIndex].status = "modified";
        return { message: modifyMsg };
      }

      default:
        return this.handleGenericFixOption(option);
    }
  }

  private advanceIndividualReview(): OrchestratorResponse {
    this.reviewIndex++;
    if (this.reviewIndex >= this.fixes.length) {
      // Finished individual review
      if (this.confirmedFixes.length === 0) {
        this.setPhase("creating-pr");
        const doneMsg: FinalizeMessage = {
          role: "assistant",
          content: "No fixes were accepted. Moving on to PR creation.",
        };
        this.messages.push(doneMsg);
        return { message: doneMsg };
      }

      this.setPhase("executing-fixes");
      const summary = this.confirmedFixes
        .map((f, i) => `${i + 1}. ${f.description}`)
        .join("\n");
      const doneMsg: FinalizeMessage = {
        role: "assistant",
        content: `Review complete. ${this.confirmedFixes.length} fix(es) accepted:\n\n${summary}\n\nMoving to execution phase.`,
      };
      this.messages.push(doneMsg);
      return { message: doneMsg };
    }

    // Show next fix
    const nextMsg = this.buildIndividualReviewMessage();
    this.messages.push(nextMsg);
    return { message: nextMsg };
  }

  private async handleGenericFixOption(
    option: ChatOption,
  ): Promise<OrchestratorResponse> {
    const msg: FinalizeMessage = {
      role: "assistant",
      content: `Selected: ${option.label}. Use the available options to manage fixes.`,
    };
    this.messages.push(msg);
    return { message: msg };
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

  private extractFixesFromParsed(parsed: ParsedResponse): void {
    for (const desc of parsed.fixDescriptions) {
      this.fixCounter++;
      const fix: FixTask = {
        id: `FIX-${String(this.fixCounter).padStart(3, "0")}`,
        description: desc,
        acceptanceCriteria: [`Fix applied: ${desc}`],
        priority: 2,
        status: "proposed",
        sourceIssue: {
          severity: "major",
          category: "code-review",
          description: desc,
        },
      };
      this.fixes.push(fix);
    }
  }

  private buildFixListMessage(): FinalizeMessage {
    const lines: string[] = ["Here are the fixes identified during the review:\n"];
    for (let i = 0; i < this.fixes.length; i++) {
      lines.push(`${i + 1}. ${this.fixes[i].description}`);
    }
    lines.push("");

    const options: ChatOption[] = [
      { label: "Accept all", description: "Accept all fixes and proceed to execution", value: "accept-all" },
      { label: "Review individually", description: "Review each fix one by one", value: "review-individually" },
      { label: "Skip fixes", description: "Skip all fixes and go straight to PR creation", value: "skip-fixes" },
      { label: "Add custom fix", description: "Add a custom fix to the list", value: "add-custom-fix" },
    ];

    return {
      role: "assistant",
      content: lines.join("\n"),
      options,
    };
  }

  private buildIndividualReviewMessage(): FinalizeMessage {
    const fix = this.fixes[this.reviewIndex];
    const progress = `(${this.reviewIndex + 1}/${this.fixes.length})`;

    const options: ChatOption[] = [
      { label: "Accept", description: "Accept this fix", value: "accept-fix" },
      { label: "Reject", description: "Reject this fix", value: "reject-fix" },
      { label: "Modify", description: "Modify this fix description", value: "modify-fix" },
    ];

    return {
      role: "assistant",
      content: `**Fix ${progress}**: ${fix.description}`,
      options,
    };
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
