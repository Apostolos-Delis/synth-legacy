import type { AgentAdapter } from "../agents/types.js";

export interface ReviewFinding {
  perspective: "developer" | "security" | "testing";
  severity: "critical" | "warning" | "info";
  message: string;
}

const REVIEW_PROMPT = `You are reviewing code changes from multiple perspectives. Analyze the git diff below and provide findings.

Output ONLY a JSON array of findings (no markdown fences, no explanation):

[
  {
    "perspective": "developer|security|testing",
    "severity": "critical|warning|info",
    "message": "description of the finding"
  }
]

Review from three perspectives:
1. **Developer**: structure, performance, conventions, code quality
2. **Security**: secrets, validation, OWASP top 10, injection risks
3. **Testing**: coverage, edge cases, missing tests

If everything looks good, return an empty array: []`;

export async function selfReview(
  agent: AgentAdapter,
  diff: string,
  cwd: string,
  model?: string,
): Promise<ReviewFinding[]> {
  const prompt = `${REVIEW_PROMPT}\n\nGit diff:\n\`\`\`\n${diff.slice(0, 50000)}\n\`\`\``;

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
