import type { AgentAdapter } from "../agents/types.js";
import type { ConversationMessage } from "../conversation/types.js";
import type { TaskFile, Task } from "../tasks/types.js";
import type { ReviewMessage, ReviewFinding } from "./types.js";
import { ConversationEngine } from "../conversation/engine.js";
import { loadTemplate } from "../templates/index.js";
import { REVIEW_TEMPLATE } from "../templates/builtin.js";

const REVIEW_PROMPT_SUFFIX = `Now review all changes made during this session. Use git diff and git log to inspect the actual code changes, cross-reference them against the plan and acceptance criteria above, and output your findings document in the specified markdown format.`;

const SEVERITY_PRIORITY: Record<ReviewFinding["severity"], Task["priority"]> = {
  critical: 1,
  warning: 2,
  info: 3,
};

export class Reviewer {
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
      readOnly: false,
      systemPrompt: REVIEW_TEMPLATE,
      promptSuffix: REVIEW_PROMPT_SUFFIX,
      persist,
    });
    this.templateReady = this.loadPhaseTemplate(agent.name, cwd);
  }

  private async loadPhaseTemplate(agentName: string, cwd: string): Promise<void> {
    const result = await loadTemplate(agentName, cwd, { phase: "review" });
    this.engine.setSystemPrompt(result.template);
  }

  async generateFindings(
    prdContent: string,
    planSummary: string,
    onChunk?: (chunk: string) => void,
    sessionSlug?: string,
  ): Promise<string> {
    await this.templateReady;
    const parts = [`## Original PRD\n\n${prdContent}\n\n## Plan Summary\n\n${planSummary}`];
    if (sessionSlug) {
      parts.push(
        `\n\n## Session Context\n\nThis session's commits are tagged with \`[${sessionSlug}]\` in their commit messages.\n` +
        `Use \`git log --grep="\\\\[${sessionSlug}\\\\]"\` to find session-specific commits, then review those changes.`,
      );
    }
    return this.engine.send(parts.join(""), onChunk);
  }

  extractFindings(response: string): ReviewFinding[] {
    const findings: ReviewFinding[] = [];
    const findingPattern =
      /###\s*\[(CRITICAL|WARNING|INFO)\]\s*(.+?)(?=\n###\s*\[|$)/gis;

    let match: RegExpExecArray | null;
    while ((match = findingPattern.exec(response)) !== null) {
      const severity = match[1].toLowerCase() as ReviewFinding["severity"];
      const title = match[2].trim();
      const block = match[0];

      const file = block.match(/\*\*File\*\*:\s*`([^`]+)`/)?.[1] ?? "";
      const lines = block.match(/\*\*Lines\*\*:\s*(.+)/)?.[1]?.trim();
      const description =
        block.match(/\*\*Description\*\*:\s*(.+)/)?.[1]?.trim() ?? "";
      const suggestion =
        block.match(/\*\*Suggestion\*\*:\s*(.+)/)?.[1]?.trim() ?? "";

      findings.push({ severity, title, file, lines, description, suggestion });
    }

    return findings;
  }

  convertToTasks(
    findings: ReviewFinding[],
    project: string,
    branchName: string,
  ): TaskFile {
    const tasks: Task[] = findings.map((finding, i) => ({
      id: `RVW-${String(i + 1).padStart(3, "0")}`,
      title: `[${finding.severity.toUpperCase()}] ${finding.title}`,
      description:
        `${finding.description}${finding.file ? `\n\nFile: ${finding.file}` : ""}${finding.lines ? `\nLines: ${finding.lines}` : ""}`,
      acceptanceCriteria: [finding.suggestion],
      priority: SEVERITY_PRIORITY[finding.severity],
      status: "open",
      iterationCount: 0,
    }));

    return {
      project,
      branchName,
      description: "Review findings from post-execution audit",
      tasks,
    };
  }

  getHistory(): ReviewMessage[] {
    return this.engine.getHistory() as ReviewMessage[];
  }

  restoreHistory(messages: ReviewMessage[]): void {
    this.engine.restoreHistory(messages);
  }
}
