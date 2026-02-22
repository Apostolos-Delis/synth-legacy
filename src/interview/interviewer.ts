import type { AgentAdapter } from "../agents/types.js";
import type { InterviewMessage, GeneratedPrd } from "./types.js";
import { INTERVIEWER_SYSTEM_PROMPT } from "./prompts.js";

export const WELCOME_MESSAGE =
  "I'll help you create a PRD. What do you want to build? " +
  "Describe it in a few sentences, and I'll ask clarifying questions.";

export class Interviewer {
  private history: InterviewMessage[] = [];

  constructor(private agent: AgentAdapter, private cwd: string, private model?: string) {}

  async respond(userMessage: string): Promise<string> {
    this.history.push({ role: "user", content: userMessage });

    const prompt = this.buildPromptWithHistory();
    const response = await this.sendToAgent(prompt);
    this.history.push({ role: "assistant", content: response });

    return response;
  }

  extractPrd(response: string): GeneratedPrd | null {
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (!jsonMatch) return null;

    try {
      return JSON.parse(jsonMatch[1]) as GeneratedPrd;
    } catch {
      return null;
    }
  }

  getHistory(): InterviewMessage[] {
    return [...this.history];
  }

  private buildPromptWithHistory(): string {
    // Sliding window: keep last 16 messages (8 turns) to prevent context overflow
    const MAX_HISTORY = 16;
    const recentHistory = this.history.slice(-MAX_HISTORY);
    const truncated = this.history.length > MAX_HISTORY;

    const turns = recentHistory
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    const prefix = truncated
      ? `${INTERVIEWER_SYSTEM_PROMPT}\n\n[Earlier conversation truncated — ${this.history.length - MAX_HISTORY} messages omitted]\n\nRecent conversation:\n\n`
      : `${INTERVIEWER_SYSTEM_PROMPT}\n\nConversation so far:\n\n`;

    return `${prefix}${turns}\n\nContinue the interview. If you have enough information, output the PRD JSON.`;
  }

  private async sendToAgent(prompt: string): Promise<string> {
    let output = "";
    const handle = this.agent.execute(prompt, {
      cwd: this.cwd,
      model: this.model,
      skipPermissions: false,
      onStdout: (chunk) => {
        output += chunk;
      },
    });
    await handle.promise;
    return output;
  }
}

export function prdToMarkdown(prd: GeneratedPrd): string {
  const lines: string[] = [];
  lines.push(`# ${prd.title}\n`);
  lines.push(`## Problem Statement\n\n${prd.problemStatement}\n`);
  lines.push(`## Goals\n\n${prd.goals.map((g) => `- ${g}`).join("\n")}\n`);
  lines.push(`## Target Users\n\n${prd.targetUsers}\n`);
  lines.push(`## Scope\n`);
  lines.push(`### Included\n\n${prd.scope.included.map((s) => `- ${s}`).join("\n")}\n`);
  lines.push(`### Excluded\n\n${prd.scope.excluded.map((s) => `- ${s}`).join("\n")}\n`);
  lines.push(`## User Stories\n`);
  for (const story of prd.userStories) {
    lines.push(`### ${story.id}: ${story.title}\n`);
    lines.push(`${story.description}\n`);
    lines.push(`**Acceptance Criteria:**`);
    lines.push(story.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n"));
    lines.push("");
  }
  lines.push(`## Quality Gates\n\n${prd.qualityGates.map((g) => `- ${g}`).join("\n")}\n`);
  return lines.join("\n");
}
