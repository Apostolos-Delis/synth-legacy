import type { AgentAdapter } from "../agents/types.js";
import type { InterviewMessage, GeneratedPrd } from "./types.js";
import type { ConversationMessage } from "../conversation/types.js";
import { ConversationEngine } from "../conversation/engine.js";
import { INTERVIEWER_SYSTEM_PROMPT } from "./prompts.js";

export const WELCOME_MESSAGE =
  "I'll help you create a PRD. What do you want to build? " +
  "Describe it in a few sentences, and I'll ask clarifying questions.";

export class Interviewer {
  private engine: ConversationEngine;

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
      systemPrompt: INTERVIEWER_SYSTEM_PROMPT,
      promptSuffix: "Continue the interview. If you have enough information, output the PRD JSON.",
      maxHistoryWindow: 16,
      persist,
    });
  }

  async respond(userMessage: string, onChunk?: (chunk: string) => void): Promise<string> {
    return this.engine.send(userMessage, onChunk);
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

  restoreHistory(messages: InterviewMessage[]): void {
    this.engine.restoreHistory(messages);
  }

  getHistory(): InterviewMessage[] {
    return this.engine.getHistory() as InterviewMessage[];
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
