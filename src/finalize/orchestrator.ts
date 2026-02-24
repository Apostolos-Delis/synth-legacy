import { join } from "node:path";
import type { AgentAdapter, AgentExecuteOptions } from "../agents/types.js";
import type { SynthConfig } from "../config/types.js";
import type { SessionPaths, SessionMetadata } from "../sessions/types.js";
import type { TaskFile } from "../tasks/types.js";
import type {
  FinalizePhase,
  FinalizeMessage,
  ChatOption,
  QuestionGroup,
  CompletionSummary,
  FixTask,
  FixTaskStatus,
  OrchestratorState,
} from "./chat-types.js";
import {
  buildAuditContext,
  buildAuditSystemPrompt,
  buildInitialAuditPrompt,
} from "./audit-chat.js";
import { writeJson, readJson, ensureDir, fileExists, readText } from "../utils/fs.js";
import { getSessionSlug } from "../sessions/slug.js";
import { spawn as defaultSpawn } from "../utils/process.js";
import type { SpawnHandle, SpawnOptions } from "../utils/process.js";
import { createPr, classifyPrError, classifyPrErrorDetail, generatePrBody, getDiffStats } from "./pr.js";
import { getCurrentBranch as defaultGetCurrentBranch } from "../utils/git.js";
import { loadTasks as defaultLoadTasks } from "../tasks/store.js";
import { ConversationEngine } from "../conversation/engine.js";
import type { ConversationMessage } from "../conversation/types.js";

export interface GitOps {
  getCurrentBranch(cwd: string): Promise<string>;
}

const OPTION_CLOSED_RE = /\[OPTION(\*?)\]([^[]*)\[\/OPTION\]/g;
const OPTION_UNCLOSED_RE = /\[OPTION(\*?)\]([^\n]*)/g;
const OPTION_ORPHAN_CLOSE_RE = /\[\/OPTION\]/g;
const QUESTION_RE = /\[QUESTION\](.*?)\[\/QUESTION\]/g;
const FIX_RE = /\[FIX\]([\s\S]*?)\[\/FIX\]/g;
const REVIEW_COMPLETE_RE = /\[REVIEW_COMPLETE\]/;
const PROCEED_COMMANDS = new Set(["proceed", "done"]);

export interface ParsedResponse {
  content: string;
  options: ChatOption[];
  questionGroups: QuestionGroup[];
  fixDescriptions: string[];
  reviewComplete: boolean;
}

function matchToOption(m: RegExpMatchArray): ChatOption | null {
  const recommended = m[1] === "*";
  const rawContent = (m[2] || "").trim();
  if (!rawContent) return null;
  const pipeIdx = rawContent.indexOf("|");
  if (pipeIdx > 0) {
    const label = rawContent.slice(0, pipeIdx).trim();
    const desc = rawContent.slice(pipeIdx + 1).trim();
    if (label) {
      return {
        label,
        description: desc,
        value: label.toLowerCase().replace(/\s+/g, "-"),
        ...(recommended ? { recommended: true } : {}),
      };
    }
  }
  return {
    label: rawContent,
    description: "",
    value: rawContent.toLowerCase().replace(/\s+/g, "-"),
    ...(recommended ? { recommended: true } : {}),
  };
}

function extractOptions(text: string): ChatOption[] {
  const options: ChatOption[] = [];
  for (const m of text.matchAll(OPTION_CLOSED_RE)) {
    const opt = matchToOption(m);
    if (opt) options.push(opt);
  }
  const afterClosed = text.replace(OPTION_CLOSED_RE, "");
  for (const m of afterClosed.matchAll(OPTION_UNCLOSED_RE)) {
    const opt = matchToOption(m);
    if (opt) options.push(opt);
  }
  return options;
}

export function parseAIResponse(raw: string): ParsedResponse {
  const fixDescriptions: string[] = [];

  for (const match of raw.matchAll(FIX_RE)) {
    const desc = match[1].trim();
    if (desc) fixDescriptions.push(desc);
  }

  const reviewComplete = REVIEW_COMPLETE_RE.test(raw);

  // Check if [QUESTION] markers exist for multi-question support
  const questionMarkers = [...raw.matchAll(QUESTION_RE)];
  let options: ChatOption[] = [];
  let questionGroups: QuestionGroup[] = [];

  if (questionMarkers.length > 0) {
    // Capture any options that appear before the first [QUESTION] marker
    const preamble = raw.slice(0, questionMarkers[0].index!);
    const preambleOptions = extractOptions(preamble);
    if (preambleOptions.length > 0) {
      questionGroups.push({ question: "", options: preambleOptions });
    }

    // Multi-question mode: parse each question group with its associated options
    for (let qi = 0; qi < questionMarkers.length; qi++) {
      const qMatch = questionMarkers[qi];
      const question = qMatch[1].trim();
      const startIdx = qMatch.index! + qMatch[0].length;
      const endIdx = qi + 1 < questionMarkers.length
        ? questionMarkers[qi + 1].index!
        : raw.length;
      const segment = raw.slice(startIdx, endIdx);

      const groupOptions = extractOptions(segment);
      questionGroups.push({ question, options: groupOptions });
    }
    // Flatten all options for backward compat
    options = questionGroups.flatMap((g) => g.options);
  } else {
    // Flat mode (backward compat): parse all [OPTION] markers as a single group
    options = extractOptions(raw);
    // Wrap as single unnamed group if there are options
    if (options.length > 0) {
      questionGroups = [{ question: "", options }];
    }
  }

  // Strip markers from displayed content
  let content = raw
    .replace(OPTION_CLOSED_RE, "")
    .replace(OPTION_UNCLOSED_RE, "")
    .replace(OPTION_ORPHAN_CLOSE_RE, "")
    .replace(QUESTION_RE, "")
    .replace(FIX_RE, "")
    .replace(REVIEW_COMPLETE_RE, "")
    .trim();

  // Collapse leftover blank lines from stripped markers
  content = content.replace(/\n{3,}/g, "\n\n");

  return { content, options, questionGroups, fixDescriptions, reviewComplete };
}

export type PhaseChangeListener = (phase: FinalizePhase) => void;

export interface OrchestratorResponse {
  message: FinalizeMessage;
}

export type SpawnFn = (options: SpawnOptions) => SpawnHandle;
export type LoadTasksFn = (path: string) => Promise<TaskFile>;

export class FinalizeOrchestrator {
  private phase: FinalizePhase = "auditing";
  private messages: FinalizeMessage[] = [];
  private engine: ConversationEngine | null = null;
  private fixes: FixTask[] = [];
  private confirmedFixes: FixTask[] = [];
  private fixCounter = 0;
  private reviewIndex = 0;
  private cwd = "";
  private phaseListeners: PhaseChangeListener[] = [];
  private prUrl: string | null = null;
  private startTime = 0;
  private baseBranch = "";
  private sessionPaths: SessionPaths | null = null;
  private gitOps: GitOps;
  private _spawn: SpawnFn;
  private _loadTasks: LoadTasksFn;

  constructor(options?: { gitOps?: GitOps; spawn?: SpawnFn; loadTasks?: LoadTasksFn }) {
    this.gitOps = options?.gitOps ?? { getCurrentBranch: defaultGetCurrentBranch };
    this._spawn = options?.spawn ?? defaultSpawn;
    this._loadTasks = options?.loadTasks ?? defaultLoadTasks;
  }

  getCurrentPhase(): FinalizePhase {
    return this.phase;
  }

  getMessages(): FinalizeMessage[] {
    return [...this.messages];
  }

  getPrUrl(): string | null {
    return this.prUrl;
  }

  getConfirmedFixes(): FixTask[] {
    return [...this.confirmedFixes];
  }

  async completeFixExecution(
    mergedCount: number,
    failedCount: number,
    agent: AgentAdapter,
    config: SynthConfig,
    sessionPaths: SessionPaths,
    onMessage: (msg: FinalizeMessage) => void,
  ): Promise<OrchestratorResponse> {
    const total = mergedCount + failedCount;
    const summaryMsg: FinalizeMessage = {
      role: "assistant",
      content: `Parallel fix execution complete: ${mergedCount}/${total} fixes merged successfully${failedCount > 0 ? `, ${failedCount} failed` : ""}.`,
    };
    this.messages.push(summaryMsg);
    onMessage(summaryMsg);

    return this.recheckAfterFixes(agent, config, sessionPaths, onMessage);
  }

  async getCompletionSummary(): Promise<CompletionSummary> {
    let tasksCompleted = 0;
    let totalTasks = 0;

    if (this.sessionPaths) {
      try {
        const taskFile = await this._loadTasks(this.sessionPaths.tasks);
        totalTasks = taskFile.tasks.length;
        tasksCompleted = taskFile.tasks.filter((t) => t.status === "done").length;
      } catch {
        // Tasks file may not exist
      }
    }

    let commitCount = 0;
    if (this.baseBranch && this.cwd) {
      try {
        const handle = this._spawn({
          cmd: ["git", "rev-list", "--count", `${this.baseBranch}..HEAD`],
          cwd: this.cwd,
        });
        const result = await handle.promise;
        if (result.exitCode === 0) {
          commitCount = parseInt(result.stdout.trim(), 10) || 0;
        }
      } catch {
        // Ignore git errors
      }
    }

    return {
      prUrl: this.prUrl,
      tasksCompleted,
      totalTasks,
      commitCount,
      fixesApplied: this.confirmedFixes.length,
      durationMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
    };
  }

  onPhaseChange(listener: PhaseChangeListener): () => void {
    this.phaseListeners.push(listener);
    return () => {
      this.phaseListeners = this.phaseListeners.filter((l) => l !== listener);
    };
  }

  private async persistState(): Promise<void> {
    if (!this.sessionPaths) return;
    const statePath = join(this.sessionPaths.root, "finalize-state.json");
    const convPath = join(this.sessionPaths.root, "finalize-conversation.json");
    const state: OrchestratorState = {
      phase: this.phase,
      fixes: this.fixes,
      confirmedFixes: this.confirmedFixes,
      reviewIndex: this.reviewIndex,
      fixCounter: this.fixCounter,
      messages: this.messages,
    };
    await writeJson(statePath, state);
    await writeJson(convPath, this.messages);
  }

  private setPhase(phase: FinalizePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    for (const listener of this.phaseListeners) {
      listener(phase);
    }
    // Persist on every phase transition for crash safety
    this.persistState().catch(() => {});
    if (phase === "complete" && this.sessionPaths) {
      this.updateMetadataToFinalized().catch((err) => {
        console.error("Failed to update metadata to finalized:", err);
      });
    }
  }

  private async updateMetadataToFinalized(): Promise<void> {
    if (!this.sessionPaths) return;
    try {
      const metaPath = join(this.sessionPaths.root, "metadata.json");
      const meta = await readJson<SessionMetadata>(metaPath);
      await writeJson(metaPath, {
        ...meta,
        status: "finalized",
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // Metadata update is best-effort
    }
  }

  /**
   * Restore orchestrator from previously-saved conversation state.
   * When savedState is provided, restores fixes, confirmedFixes, reviewIndex,
   * fixCounter, and phase. Otherwise falls back to "discussing" phase.
   */
  restore(
    agent: AgentAdapter,
    config: SynthConfig,
    sessionPaths: SessionPaths,
    cwd: string,
    savedMessages: FinalizeMessage[],
    savedState?: OrchestratorState,
  ): void {
    this.cwd = cwd;
    this.startTime = Date.now();
    this.baseBranch = config.project.base_branch;
    this.sessionPaths = sessionPaths;

    this.engine = new ConversationEngine({
      agent,
      cwd,
      model: config.agent.model,
      systemPrompt: buildAuditSystemPrompt(),
      persist: async () => {
        await ensureDir(sessionPaths.root);
        await this.persistState();
      },
    });

    // Convert FinalizeMessage[] to ConversationMessage[] for the engine
    // (engine only needs role + content for prompt reconstruction)
    const engineMessages: ConversationMessage[] = savedMessages
      .filter((m): m is FinalizeMessage & { role: "user" | "assistant" } =>
        m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));
    this.engine.restoreHistory(engineMessages);

    if (savedState) {
      this.fixes = savedState.fixes;
      this.confirmedFixes = savedState.confirmedFixes;
      this.reviewIndex = savedState.reviewIndex;
      this.fixCounter = savedState.fixCounter;
      this.messages = savedState.messages;

      const safePhases = new Set<FinalizePhase>(["discussing", "collecting-fixes", "creating-pr"]);
      this.setPhase(safePhases.has(savedState.phase) ? savedState.phase : "discussing");
    } else {
      this.messages = [...savedMessages];
      this.setPhase("discussing");
    }
  }

  async start(
    agent: AgentAdapter,
    config: SynthConfig,
    sessionPaths: SessionPaths,
    cwd: string,
    onChunk?: (chunk: string) => void,
  ): Promise<OrchestratorResponse> {
    this.cwd = cwd;
    this.startTime = Date.now();
    this.baseBranch = config.project.base_branch;
    this.sessionPaths = sessionPaths;
    this.setPhase("auditing");

    this.engine = new ConversationEngine({
      agent,
      cwd,
      model: config.agent.model,
      systemPrompt: buildAuditSystemPrompt(),
      persist: async () => {
        await ensureDir(sessionPaths.root);
        await this.persistState();
      },
    });

    // Build the audit context from git diff + task file
    const auditContext = await buildAuditContext(
      sessionPaths,
      cwd,
      config.project.base_branch,
    );

    const userPrompt = buildInitialAuditPrompt(auditContext);

    // Send to AI and get the initial review
    const response = await this.engine.send(userPrompt, onChunk);
    const parsed = parseAIResponse(response);

    // Extract any fix proposals from the initial audit
    this.extractFixesFromParsed(parsed);

    const assistantMsg: FinalizeMessage = {
      role: "assistant",
      content: parsed.content,
      ...(parsed.questionGroups.length > 0 ? { questionGroups: parsed.questionGroups } : {}),
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

    let response: OrchestratorResponse;
    switch (this.phase) {
      case "discussing":
        response = await this.handleDiscussing(agent, text, onChunk);
        break;
      case "collecting-fixes":
        response = await this.handleCollectingFixes(agent, text, onChunk);
        break;
      case "executing-fixes":
      case "creating-pr":
      case "complete":
        response = await this.handleGenericResponse(agent, text, onChunk);
        break;
      default:
        response = await this.handleGenericResponse(agent, text, onChunk);
        break;
    }
    await this.persistState();
    return response;
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

    let response: OrchestratorResponse;
    if (this.phase === "discussing") {
      response = await this.handleDiscussionOption(agent, option, onChunk);
    } else if (this.phase === "collecting-fixes") {
      response = await this.handleFixOption(agent, option, onChunk);
    } else if (this.phase === "executing-fixes") {
      response = this.handleExecutingFixesOption(option);
    } else if (this.phase === "creating-pr") {
      response = this.handleCreatingPrOption(option);
    } else {
      response = await this.handleGenericResponse(
        agent,
        `The user selected: "${option.label}" — ${option.description}`,
        onChunk,
      );
    }
    await this.persistState();
    return response;
  }

  // ---------------------------------------------------------------------------
  // Phase handlers
  // ---------------------------------------------------------------------------

  private async handleDiscussing(
    _agent: AgentAdapter,
    text: string,
    onChunk?: (chunk: string) => void,
  ): Promise<OrchestratorResponse> {
    // Check for user shortcut to skip remaining Q&A
    if (PROCEED_COMMANDS.has(text.trim().toLowerCase())) {
      return this.transitionToCollectingFixes();
    }

    const instruction =
      `The user is in the discussion phase of a code review. They said:\n\n"${text}"\n\n` +
      `Continue the code review discussion by asking your next follow-up question on a single topic. ` +
      `If you want to offer choices, use [OPTION]label|description[/OPTION] markers (2-4 options). ` +
      `Use [OPTION*] (with asterisk) for the recommended choice. ` +
      `If you have 2-3 related questions, batch them with [QUESTION]header[/QUESTION] markers. ` +
      `If you want to propose a fix, use [FIX]description of fix[/FIX] markers. ` +
      `If you have no more concerns, end with [REVIEW_COMPLETE]. Be concise.`;

    const response = await this.engine!.send(instruction, onChunk);
    return this.processDiscussingResponse(response);
  }

  private async handleDiscussionOption(
    _agent: AgentAdapter,
    option: ChatOption,
    onChunk?: (chunk: string) => void,
  ): Promise<OrchestratorResponse> {
    if (option.value === "collect-fixes" || option.value === "fix") {
      return this.transitionToCollectingFixes();
    }

    const instruction =
      `The user selected the option: "${option.label}" (${option.description}).\n\n` +
      `Respond based on their choice, then ask your next follow-up question on a single topic. ` +
      `If you want to offer choices, use [OPTION]label|description[/OPTION] markers (2-4 options). ` +
      `Use [OPTION*] (with asterisk) for the recommended choice. ` +
      `If you have 2-3 related questions, batch them with [QUESTION]header[/QUESTION] markers. ` +
      `If you want to propose a fix, use [FIX]description of fix[/FIX] markers. ` +
      `If you have no more concerns, end with [REVIEW_COMPLETE]. Be concise.`;

    const response = await this.engine!.send(instruction, onChunk);
    return this.processDiscussingResponse(response);
  }

  private processDiscussingResponse(response: string): OrchestratorResponse {
    const parsed = parseAIResponse(response);

    // Extract any [FIX] markers from the AI response
    this.extractFixesFromParsed(parsed);

    const assistantMsg: FinalizeMessage = {
      role: "assistant",
      content: parsed.content,
      ...(parsed.questionGroups.length > 0 ? { questionGroups: parsed.questionGroups } : {}),
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
    // Persist after each fix confirmation for crash safety
    this.persistState().catch(() => {});
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

  private handleGenericFixOption(
    option: ChatOption,
  ): OrchestratorResponse {
    const msg: FinalizeMessage = {
      role: "assistant",
      content: `Selected: ${option.label}. Use the available options to manage fixes.`,
    };
    this.messages.push(msg);
    return { message: msg };
  }

  private handleExecutingFixesOption(
    option: ChatOption,
  ): OrchestratorResponse {
    switch (option.value) {
      case "another-round": {
        // Reset fixes for a new round — keep the confirmed list for reference
        this.fixes = [];
        this.confirmedFixes = [];
        this.fixCounter = 0;
        this.reviewIndex = 0;
        this.setPhase("discussing");
        const msg: FinalizeMessage = {
          role: "assistant",
          content: "Starting another round of review. What would you like to address?",
        };
        this.messages.push(msg);
        return { message: msg };
      }

      case "proceed-to-pr": {
        this.setPhase("creating-pr");
        const msg: FinalizeMessage = {
          role: "assistant",
          content: "All fixes applied. Moving on to PR creation.",
        };
        this.messages.push(msg);
        return { message: msg };
      }

      default: {
        const msg: FinalizeMessage = {
          role: "assistant",
          content: `Selected: ${option.label}. Use the available options to proceed.`,
        };
        this.messages.push(msg);
        return { message: msg };
      }
    }
  }

  private handleCreatingPrOption(
    option: ChatOption,
  ): OrchestratorResponse {
    switch (option.value) {
      case "retry-pr": {
        const msg: FinalizeMessage = {
          role: "assistant",
          content: "Retrying PR creation...",
        };
        this.messages.push(msg);
        return { message: msg };
      }

      case "exit": {
        this.setPhase("complete");
        const msg: FinalizeMessage = {
          role: "assistant",
          content: "Exiting without creating a PR. You can create one manually later.",
        };
        this.messages.push(msg);
        return { message: msg };
      }

      default: {
        const msg: FinalizeMessage = {
          role: "assistant",
          content: `Selected: ${option.label}. Use the available options to proceed.`,
        };
        this.messages.push(msg);
        return { message: msg };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Fix execution
  // ---------------------------------------------------------------------------

  async executeFixes(
    agent: AgentAdapter,
    config: SynthConfig,
    sessionPaths: SessionPaths,
    onMessage: (msg: FinalizeMessage) => void,
  ): Promise<OrchestratorResponse> {
    // AC #6: If no fixes were confirmed, skip entirely
    if (this.confirmedFixes.length === 0) {
      this.setPhase("creating-pr");
      const skipMsg: FinalizeMessage = {
        role: "assistant",
        content: "No confirmed fixes to execute. Moving on to PR creation.",
      };
      this.messages.push(skipMsg);
      await this.persistState();
      return { message: skipMsg };
    }

    const total = this.confirmedFixes.length;

    // AC #2 & #3: Execute each fix using the same agent, reporting progress
    for (let i = 0; i < total; i++) {
      const fix = this.confirmedFixes[i];
      const progress = `${i + 1}/${total}`;

      const startMsg: FinalizeMessage = {
        role: "assistant",
        content: `Executing fix ${progress}: ${fix.description}`,
      };
      this.messages.push(startMsg);
      onMessage(startMsg);

      try {
        const prompt = buildFixPrompt(fix, this.cwd);
        await this.sendToAgentDirect(agent, prompt);

        const doneMsg: FinalizeMessage = {
          role: "assistant",
          content: `Fix ${progress} complete.`,
        };
        this.messages.push(doneMsg);
        onMessage(doneMsg);
      } catch (err) {
        // AC #7: Report failures without crashing
        const errMsg = err instanceof Error ? err.message : String(err);
        const failMsg: FinalizeMessage = {
          role: "assistant",
          content: `Fix ${progress} failed: ${errMsg}`,
        };
        this.messages.push(failMsg);
        onMessage(failMsg);
      }
    }

    // AC #4: Quick re-check of changes after fixes
    return this.recheckAfterFixes(agent, config, sessionPaths, onMessage);
  }

  // AC #4 & #5: Re-check changes and present options
  private async recheckAfterFixes(
    _agent: AgentAdapter,
    config: SynthConfig,
    _sessionPaths: SessionPaths,
    onMessage: (msg: FinalizeMessage) => void,
  ): Promise<OrchestratorResponse> {
    const recheckMsg: FinalizeMessage = {
      role: "assistant",
      content: "Re-checking changes after fixes...",
    };
    this.messages.push(recheckMsg);
    onMessage(recheckMsg);

    // Get the current diff to re-check
    const diffHandle = this._spawn({
      cmd: ["git", "diff", `${config.project.base_branch}...HEAD`],
      cwd: this.cwd,
    });
    const diffResult = await diffHandle.promise;
    const diff = diffResult.exitCode === 0 ? diffResult.stdout : "";

    // Also get unstaged changes from fix execution
    const unstagedHandle = this._spawn({
      cmd: ["git", "diff"],
      cwd: this.cwd,
    });
    const unstagedResult = await unstagedHandle.promise;
    const unstagedDiff =
      unstagedResult.exitCode === 0 ? unstagedResult.stdout : "";

    const combinedDiff = [diff, unstagedDiff].filter(Boolean).join("\n");

    const recheckInstruction =
      `You just applied fixes to the codebase. Do a quick re-check of the current diff to see if the fixes introduced any new issues.\n\n` +
      `## Current Diff\n\n\`\`\`diff\n${combinedDiff.slice(0, 30_000)}\n\`\`\`\n\n` +
      `If you find new issues, describe them briefly and propose fixes using [FIX]description[/FIX] markers.\n` +
      `If everything looks clean, just say so. Be concise.`;

    const recheckResponse = await this.engine!.send(recheckInstruction);
    const parsed = parseAIResponse(recheckResponse);

    if (parsed.fixDescriptions.length > 0) {
      // New issues found — present options for another round
      this.extractFixesFromParsed(parsed);

      const options: ChatOption[] = [
        {
          label: "Another round",
          description: "Do another round of fixes",
          value: "another-round",
        },
        {
          label: "Proceed to PR",
          description: "Skip remaining issues and create the PR",
          value: "proceed-to-pr",
        },
      ];

      const resultMsg: FinalizeMessage = {
        role: "assistant",
        content: `${parsed.content}\n\nNew issues were found after applying fixes.`,
        questionGroups: [{ question: "", options }],
      };
      this.messages.push(resultMsg);
      return { message: resultMsg };
    }

    // No new issues — auto-transition to creating-pr
    this.setPhase("creating-pr");
    const cleanMsg: FinalizeMessage = {
      role: "assistant",
      content: `${parsed.content}\n\nNo new issues found. Moving on to PR creation.`,
    };
    this.messages.push(cleanMsg);
    return { message: cleanMsg };
  }

  // ---------------------------------------------------------------------------
  // PR creation
  // ---------------------------------------------------------------------------

  async executePrCreation(
    config: SynthConfig,
    sessionPaths: SessionPaths,
    onMessage: (msg: FinalizeMessage) => void,
  ): Promise<OrchestratorResponse> {
    let response: OrchestratorResponse;
    try {
      response = await this.executePrCreationInner(config, sessionPaths, onMessage);
    } finally {
      await this.persistState();
    }
    return response;
  }

  private async executePrCreationInner(
    config: SynthConfig,
    sessionPaths: SessionPaths,
    onMessage: (msg: FinalizeMessage) => void,
  ): Promise<OrchestratorResponse> {
    const baseBranch = config.project.base_branch;

    // Skip PR creation if on base branch
    let branch: string;
    try {
      branch = await this.gitOps.getCurrentBranch(this.cwd);
    } catch (err) {
      const raw = `Failed to detect branch: ${err instanceof Error ? err.message : String(err)}`;
      return this.prError(raw, onMessage);
    }

    // AC #1: Stage any uncommitted changes and commit (even on base branch)
    const addHandle = this._spawn({ cmd: ["git", "add", "-A"], cwd: this.cwd });
    await addHandle.promise;

    const hasStagedHandle = this._spawn({
      cmd: ["git", "diff", "--cached", "--quiet"],
      cwd: this.cwd,
    });
    const hasStagedResult = await hasStagedHandle.promise;

    if (hasStagedResult.exitCode !== 0) {
      // There are staged changes — commit them
      let taskFile;
      try {
        taskFile = await this._loadTasks(sessionPaths.tasks);
      } catch {
        taskFile = { description: "", tasks: [] };
      }
      const scope = await getSessionSlug(sessionPaths);
      const commitMsg = `feat: [${scope}] ${taskFile.description || config.project.name}`;
      const commitHandle = this._spawn({
        cmd: ["git", "commit", "-m", commitMsg],
        cwd: this.cwd,
      });
      const commitResult = await commitHandle.promise;

      if (commitResult.exitCode !== 0) {
        return this.prError(commitResult.stderr || "Commit failed", onMessage);
      }

      const commitInfo: FinalizeMessage = {
        role: "assistant",
        content: `Committed changes: "${commitMsg}"`,
      };
      this.messages.push(commitInfo);
      onMessage(commitInfo);
    }

    // Skip PR creation if on base branch (changes are already committed above)
    if (branch === baseBranch) {
      this.setPhase("complete");
      const hasCommit = hasStagedResult.exitCode !== 0;
      const skipMsg: FinalizeMessage = {
        role: "assistant",
        content: hasCommit
          ? `Changes committed to '${branch}'. Skipping PR creation (already on base branch).`
          : `No uncommitted changes. Skipping PR creation (already on base branch).`,
      };
      this.messages.push(skipMsg);
      onMessage(skipMsg);
      return { message: skipMsg };
    }

    // AC #2: Push branch with upstream tracking
    const pushMsg: FinalizeMessage = {
      role: "assistant",
      content: `Pushing branch "${branch}" to origin...`,
    };
    this.messages.push(pushMsg);
    onMessage(pushMsg);

    // AC #3 & #4: Generate PR body and create the PR
    let taskFile;
    try {
      taskFile = await this._loadTasks(sessionPaths.tasks);
    } catch (err) {
      const raw = `Failed to load tasks: ${err instanceof Error ? err.message : String(err)}`;
      return this.prError(raw, onMessage);
    }

    const prdExists = await fileExists(sessionPaths.prd);
    const prdContent = prdExists ? await readText(sessionPaths.prd) : null;
    const diffStats = await getDiffStats(this.cwd, baseBranch, this._spawn);

    const body = generatePrBody(taskFile, prdContent, [], diffStats);
    const title = taskFile.description || config.project.name;

    try {
      const result = await createPr(this.cwd, branch, title, body, this._spawn);

      // AC #5: Store PR URL in state and transition to complete
      this.prUrl = result.url;
      this.setPhase("complete");

      const successMsg: FinalizeMessage = {
        role: "assistant",
        content: `PR created successfully: ${result.url}`,
      };
      this.messages.push(successMsg);
      return { message: successMsg };
    } catch (err) {
      // AC #6: Show error with retry option — classify for user-friendly message
      const raw = err instanceof Error ? err.message : String(err);
      return this.prError(raw, onMessage);
    }
  }

  private prError(
    rawError: string,
    onMessage: (msg: FinalizeMessage) => void,
  ): OrchestratorResponse {
    const detail = classifyPrErrorDetail(rawError);
    const classified = classifyPrError(rawError);

    const lines: string[] = [
      `**Finalize failed** — ${classified}`,
      "",
      `**Error type:** ${detail.errorType}`,
    ];

    // Include raw output (truncated) so the user can diagnose
    const trimmedOutput = detail.rawOutput.trim();
    if (trimmedOutput && trimmedOutput !== classified) {
      const truncated = trimmedOutput.length > 500
        ? trimmedOutput.slice(0, 500) + "..."
        : trimmedOutput;
      lines.push("", "**Output:**", "```", truncated, "```");
    }

    lines.push("", `**Suggested fix:** ${detail.suggestedFix}`);

    const options: ChatOption[] = [
      {
        label: "Retry",
        description: "Retry PR creation",
        value: "retry-pr",
      },
      {
        label: "Exit",
        description: "Exit without creating a PR",
        value: "exit",
      },
    ];

    const errMsg: FinalizeMessage = {
      role: "assistant",
      content: lines.join("\n"),
      questionGroups: [{ question: "", options }],
      error: detail,
    };
    this.messages.push(errMsg);
    onMessage(errMsg);
    return { message: errMsg };
  }

  private async handleGenericResponse(
    agent: AgentAdapter,
    text: string,
    onChunk?: (chunk: string) => void,
  ): Promise<OrchestratorResponse> {
    const instruction = `The user said:\n\n"${text}"\n\nRespond helpfully in the context of the code review.`;

    const response = this.engine
      ? await this.engine.send(instruction, onChunk)
      : await this.sendToAgentDirect(agent, instruction, onChunk);

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
      questionGroups: [{ question: "", options }],
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
      questionGroups: [{ question: "", options }],
    };
  }

  // ---------------------------------------------------------------------------
  // Direct agent communication (for fix execution — not part of conversation)
  // ---------------------------------------------------------------------------

  private async sendToAgentDirect(
    agent: AgentAdapter,
    prompt: string,
    onChunk?: (chunk: string) => void,
  ): Promise<string> {
    let output = "";
    const options: AgentExecuteOptions = {
      cwd: this.cwd,
      skipPermissions: false,
      onStdout: (chunk) => {
        output += chunk;
        onChunk?.(chunk);
      },
    };

    const handle = agent.execute(prompt, options);
    const result = await handle.promise;
    if (result.timedOut) {
      throw new Error("Agent execution timed out");
    }
    if (result.exitCode !== 0) {
      throw new Error(`Agent exited with code ${result.exitCode}: ${result.stderr}`);
    }
    return output;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildFixPrompt(fix: FixTask, cwd: string): string {
  return [
    `You are a coding agent applying a fix identified during code review.`,
    ``,
    `## Working Directory`,
    cwd,
    ``,
    `## Fix to Apply`,
    `**ID**: ${fix.id}`,
    `**Description**: ${fix.description}`,
    ``,
    `## Acceptance Criteria`,
    ...fix.acceptanceCriteria.map((c) => `- ${c}`),
    ``,
    `## Instructions`,
    `1. Read the relevant files to understand the current code.`,
    `2. Make the minimal changes needed to apply this fix.`,
    `3. Do NOT make unrelated changes.`,
    `4. Ensure the code compiles and is correct after your changes.`,
  ].join("\n");
}
