import type { AgentAdapter } from "../agents/types.js";
import { loadTemplate } from "../templates/index.js";
import { truncateDiff } from "../utils/git.js";

export interface ReviewFinding {
  perspective: "developer" | "security" | "testing";
  severity: "critical" | "warning" | "info";
  message: string;
}

export async function selfReview(
  agent: AgentAdapter,
  diff: string,
  cwd: string,
  model?: string,
): Promise<ReviewFinding[]> {
  const templateResult = await loadTemplate("self-review", cwd, { phase: "audit" });
  const prompt = `${templateResult.template}\n\nGit diff:\n\`\`\`\n${truncateDiff(diff)}\n\`\`\``;

  let output = "";
  const handle = agent.execute(prompt, {
    cwd,
    model,
    skipPermissions: false,
    onStdout: (chunk) => {
      output += chunk;
    },
  });
  const result = await handle.promise;
  if (result.timedOut) {
    throw new Error("Review agent timed out");
  }
  if (result.exitCode !== 0) {
    throw new Error(`Review agent exited with code ${result.exitCode}: ${result.stderr}`);
  }

  // Try fenced JSON first, then greedy match
  const fencedMatch = output.match(/```json\s*(\[[\s\S]*?\])\s*```/);
  const raw = fencedMatch?.[1] ?? output.match(/\[[\s\S]*\]/)?.[0];
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate findings have required fields
    return parsed.filter(
      (f: unknown) =>
        f && typeof f === "object" && "severity" in f && "message" in f,
    ) as ReviewFinding[];
  } catch {
    return [];
  }
}
