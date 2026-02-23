import { join } from "node:path";
import type { AgentAdapter, AgentExecuteOptions } from "../agents/types.js";
import type { SynthConfig } from "../config/types.js";
import type { PlanPaths, PlanMetadata } from "../plans/types.js";
import type { Task, TaskFile } from "../tasks/types.js";
import type {
  FinalizePhase,
  FinalizeMessage,
  ChatOption,
  CompletionSummary,
  FixTask,
  FixTaskStatus,
} from "./chat-types.js";
import {
  buildAuditContext,
  buildAuditSystemPrompt,
  buildInitialAuditPrompt,
} from "./audit-chat.js";
import { writeJson, readJson, ensureDir, fileExists, readText } from "../utils/fs.js";
import { spawn } from "../utils/process.js";
import { createPr, generatePrBody, getDiffStats } from "./pr.js";
import { getCurrentBranch } from "../utils/git.js";
import { loadTasks } from "../tasks/store.js";

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
  private prUrl: string | null = null;
  private startTime = 0;
  private baseBranch = "";
  private planPaths: PlanPaths | null = null;

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

  getPrUrl(): string | null {
    return this.prUrl;
  }

  async getCompletionSummary(): Promise<CompletionSummary> {
    let tasksCompleted = 0;
    let totalTasks = 0;

    if (this.planPaths) {
      try {
        const taskFile = await loadTasks(this.planPaths.tasks);
        totalTasks = taskFile.tasks.length;
        tasksCompleted = taskFile.tasks.filter((t) => t.status === "done").length;
      } catch {
        // Tasks file may not exist
      }
    }

    let commitCount = 0;
    if (this.baseBranch && this.cwd) {
      try {
        const handle = spawn({
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

  private setPhase(phase: FinalizePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    for (const listener of this.phaseListeners) {
      listener(phase);
    }
    if (phase === "complete" && this.planPaths) {
      this.updateMetadataToFinalized();
    }
  }

  private async updateMetadataToFinalized(): Promise<void> {
    if (!this.planPaths) return;
    try {
      const metaPath = join(this.planPaths.root, "metadata.json");
      const meta = await readJson<PlanMetadata>(metaPath);
      await writeJson(metaPath, {
        ...meta,
        status: "finalized",
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // Metadata update is best-effort
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
    this.startTime = Date.now();
    this.baseBranch = config.project.base_branch;
    this.planPaths = planPaths;
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

    if (this.phase === "executing-fixes") {
      return this.handleExecutingFixesOption(option);
    }

    if (this.phase === "creating-pr") {
      return this.handleCreatingPrOption(option);
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
    planPaths: PlanPaths,
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
      return { message: skipMsg };
    }

    const total = this.confirmedFixes.length;

    // AC #1: Convert FixTasks to Task[] and write temporary tasks file
    const fixTasks = this.confirmedFixes.map((fix, i) =>
      fixTaskToEngineTask(fix, i),
    );
    const fixTaskFile: TaskFile = {
      project: config.project.name,
      branchName: config.project.branch,
      description: "Fix tasks from code review",
      tasks: fixTasks,
    };

    const fixTasksPath = join(planPaths.root, "fix-tasks.json");
    await ensureDir(planPaths.root);
    await writeJson(fixTasksPath, fixTaskFile);

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
        await this.sendToAgent(agent, prompt);

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
    return this.recheckAfterFixes(agent, config, planPaths, onMessage);
  }

  // AC #4 & #5: Re-check changes and present options
  private async recheckAfterFixes(
    agent: AgentAdapter,
    config: SynthConfig,
    _planPaths: PlanPaths,
    onMessage: (msg: FinalizeMessage) => void,
  ): Promise<OrchestratorResponse> {
    const recheckMsg: FinalizeMessage = {
      role: "assistant",
      content: "Re-checking changes after fixes...",
    };
    this.messages.push(recheckMsg);
    onMessage(recheckMsg);

    // Get the current diff to re-check
    const diffHandle = spawn({
      cmd: ["git", "diff", `${config.project.base_branch}...HEAD`],
      cwd: this.cwd,
    });
    const diffResult = await diffHandle.promise;
    const diff = diffResult.exitCode === 0 ? diffResult.stdout : "";

    // Also get unstaged changes from fix execution
    const unstagedHandle = spawn({
      cmd: ["git", "diff"],
      cwd: this.cwd,
    });
    const unstagedResult = await unstagedHandle.promise;
    const unstagedDiff =
      unstagedResult.exitCode === 0 ? unstagedResult.stdout : "";

    const combinedDiff = [diff, unstagedDiff].filter(Boolean).join("\n");

    const recheckPrompt =
      `${this.systemPrompt}\n\n` +
      `You just applied fixes to the codebase. Do a quick re-check of the current diff to see if the fixes introduced any new issues.\n\n` +
      `## Current Diff\n\n\`\`\`diff\n${combinedDiff.slice(0, 30_000)}\n\`\`\`\n\n` +
      `If you find new issues, describe them briefly and propose fixes using [FIX]description[/FIX] markers.\n` +
      `If everything looks clean, just say so. Be concise.`;

    const recheckResponse = await this.sendToAgent(agent, recheckPrompt);
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
        options,
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
    planPaths: PlanPaths,
    onMessage: (msg: FinalizeMessage) => void,
  ): Promise<OrchestratorResponse> {
    const baseBranch = config.project.base_branch;

    // AC #1: Stage any uncommitted changes and commit
    const addHandle = spawn({ cmd: ["git", "add", "-A"], cwd: this.cwd });
    await addHandle.promise;

    const hasStagedHandle = spawn({
      cmd: ["git", "diff", "--cached", "--quiet"],
      cwd: this.cwd,
    });
    const hasStagedResult = await hasStagedHandle.promise;

    if (hasStagedResult.exitCode !== 0) {
      // There are staged changes — commit them
      const taskFile = await loadTasks(planPaths.tasks);
      const commitMsg = `feat: ${taskFile.description || config.project.name}`;
      const commitHandle = spawn({
        cmd: ["git", "commit", "-m", commitMsg],
        cwd: this.cwd,
      });
      const commitResult = await commitHandle.promise;

      if (commitResult.exitCode !== 0) {
        return this.prError(
          `Commit failed: ${commitResult.stderr}`,
          onMessage,
        );
      }

      const commitInfo: FinalizeMessage = {
        role: "assistant",
        content: `Committed changes: "${commitMsg}"`,
      };
      this.messages.push(commitInfo);
      onMessage(commitInfo);
    }

    // AC #2: Push branch with upstream tracking
    let branch: string;
    try {
      branch = await getCurrentBranch(this.cwd);
    } catch (err) {
      return this.prError(
        `Failed to detect branch: ${err instanceof Error ? err.message : String(err)}`,
        onMessage,
      );
    }

    const pushMsg: FinalizeMessage = {
      role: "assistant",
      content: `Pushing branch "${branch}" to origin...`,
    };
    this.messages.push(pushMsg);
    onMessage(pushMsg);

    // AC #3 & #4: Generate PR body and create the PR
    let taskFile;
    try {
      taskFile = await loadTasks(planPaths.tasks);
    } catch (err) {
      return this.prError(
        `Failed to load tasks: ${err instanceof Error ? err.message : String(err)}`,
        onMessage,
      );
    }

    const prdExists = await fileExists(planPaths.prd);
    const prdContent = prdExists ? await readText(planPaths.prd) : null;
    const diffStats = await getDiffStats(this.cwd, baseBranch);

    const body = generatePrBody(taskFile, prdContent, [], diffStats);
    const title = taskFile.description || config.project.name;

    try {
      const result = await createPr(this.cwd, branch, title, body);

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
      // AC #6: Show error with retry option
      return this.prError(
        err instanceof Error ? err.message : String(err),
        onMessage,
      );
    }
  }

  private prError(
    errorText: string,
    onMessage: (msg: FinalizeMessage) => void,
  ): OrchestratorResponse {
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
      content: `PR creation failed: ${errorText}`,
      options,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixTaskToEngineTask(fix: FixTask, _index: number): Task {
  return {
    id: fix.id,
    title: fix.description.length > 100
      ? fix.description.slice(0, 97) + "..."
      : fix.description,
    description: fix.description,
    acceptanceCriteria: fix.acceptanceCriteria,
    priority: fix.priority as 1 | 2 | 3 | 4 | 5,
    status: "open",
    iterationCount: 0,
  };
}

function buildFixPrompt(fix: FixTask, cwd: string): string {
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
