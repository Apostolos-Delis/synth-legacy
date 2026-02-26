import type { AgentAdapter, AgentToolEvent } from "../agents/types.js";

export interface PrdReviewOptions {
  cwd: string;
  model?: string;
  showToolLogs?: boolean;
  maxAttempts?: number;
  onChunk?: (chunk: string) => void;
  onTool?: (event: AgentToolEvent) => void;
  onReset?: () => void;
}

export type PrdReviewOutcome =
  | { status: "success"; prd: string; rawOutput: string }
  | { status: "cancelled" }
  | { status: "failed" };

export function buildRevisionPrompt(currentPrd: string, feedback: string): string {
  return `You are revising a Product Requirements Document (PRD) based on user feedback.

Here is the current PRD:

${currentPrd}

The user has requested the following changes:

${feedback}

Please output the complete revised PRD in markdown format. Wrap the entire revised PRD in a markdown code block with the \`markdown\` language tag:

\`\`\`markdown
(revised PRD here)
\`\`\`

Only output the revised PRD in the code block. Do not include any other text.`;
}

export function extractMarkdownPrd(output: string): string | null {
  const match = output.match(/```markdown\s*([\s\S]*?)\s*```/);
  return match ? match[1].trim() : null;
}

function isCancellationError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("cancel"));
}

export async function revisePrd(
  agent: AgentAdapter,
  currentPrd: string,
  feedback: string,
  options: PrdReviewOptions,
): Promise<PrdReviewOutcome> {
  const prompt = buildRevisionPrompt(currentPrd, feedback);
  const maxAttempts = options.maxAttempts ?? 2;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) options.onReset?.();
    let output = "";
    try {
      const handle = agent.execute(prompt, {
        cwd: options.cwd,
        model: options.model,
        readOnly: true,
        skipPermissions: false,
        onStdout: (chunk) => {
          output += chunk;
          options.onChunk?.(chunk);
        },
        onTool: options.showToolLogs === false ? undefined : options.onTool,
      });
      const result = await handle.promise;
      output = result.stdout;
      if (result.timedOut) {
        throw new Error("PRD revision agent timed out");
      }
      if (result.exitCode !== 0) {
        throw new Error(`PRD revision agent exited with code ${result.exitCode}: ${result.stderr}`);
      }
      const revisedPrd = extractMarkdownPrd(output) || output;
      return { status: "success", prd: revisedPrd, rawOutput: output };
    } catch (err) {
      if (isCancellationError(err)) {
        return { status: "cancelled" };
      }
    }
  }

  return { status: "failed" };
}
