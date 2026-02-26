import type { AgentAdapter, AgentToolEvent } from "../agents/types.js";
import type { InterviewMessage } from "./types.js";
import type { ConversationMessage } from "../conversation/types.js";
import { ConversationEngine } from "../conversation/engine.js";
import { loadTemplate } from "../templates/index.js";
import { INTERVIEW_TEMPLATE } from "../templates/builtin.js";

export const WELCOME_MESSAGE =
  "I'll help you create a PRD. What do you want to build? " +
  "Describe it in a few sentences, and I'll ask clarifying questions.";

export class Interviewer {
  private engine: ConversationEngine;
  private templateReady: Promise<void>;

  constructor(
    agent: AgentAdapter,
    cwd: string,
    model?: string,
    persist?: (messages: ConversationMessage[]) => void | Promise<void>,
  ) {
    this.engine = new ConversationEngine({
      agent,
      cwd,
      model,
      readOnly: true,
      systemPrompt: INTERVIEW_TEMPLATE,
      promptSuffix: "Continue the interview. Prefer inferring implementation details from context over asking the user. If you can confidently address all checklist areas, write the complete PRD starting with a level-1 heading.",
      persist,
    });
    this.templateReady = this.loadPhaseTemplate(agent.name ?? "default", cwd);
  }

  private async loadPhaseTemplate(agentName: string, cwd: string): Promise<void> {
    const result = await loadTemplate(agentName, cwd, { phase: "interview" });
    this.engine.setSystemPrompt(result.template);
  }

  async respond(userMessage: string, onChunk?: (chunk: string) => void, onTool?: (event: AgentToolEvent) => void): Promise<string> {
    await this.templateReady;
    const response = await this.engine.send(userMessage, onChunk, onTool);
    if (shouldRetryInterview(response)) {
      return this.engine.retryLast(
        "You already explored the codebase using tools. Summarize key findings and ask the next targeted questions or provide the full PRD now. Do not defer.",
        onChunk,
        onTool,
      );
    }
    return response;
  }

  extractPrdMarkdown(response: string): string | null {
    const match = response.match(/^(# .+)/ms);
    if (!match) return null;
    return response.slice(response.indexOf(match[1]));
  }

  restoreHistory(messages: InterviewMessage[]): void {
    this.engine.restoreHistory(messages);
  }

  getHistory(): InterviewMessage[] {
    return this.engine.getHistory() as InterviewMessage[];
  }
}

function shouldRetryInterview(response: string): boolean {
  const trimmed = response.trim().toLowerCase();
  if (!trimmed) return false;
  const deferrals = [
    "let me explore",
    "let me take a look",
    "let me first",
    "i'll explore",
    "i will explore",
    "i should explore",
    "let me dig in",
    "let me review the codebase",
    "let me look at the codebase",
  ];
  if (deferrals.some((d) => trimmed.startsWith(d))) return true;
  if (trimmed.includes("before asking targeted questions")) return true;
  return false;
}

export function extractPrdTitle(markdown: string): string {
  const match = markdown.match(/^# (.+)$/m);
  return match ? match[1].trim() : "";
}
