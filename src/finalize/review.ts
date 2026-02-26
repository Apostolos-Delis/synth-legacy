import type { AgentAdapter } from "../agents/types.js";
import { loadTemplate } from "../templates/index.js";
import { truncateDiff } from "../utils/git.js";
import { getLogger } from "../logging/logger.js";

const TOOL_INPUT_LIMIT = 600;
const TOOL_OUTPUT_LIMIT = 1200;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

function toDisplay(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

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
  const logger = getLogger();
  const templateResult = await loadTemplate("self-review", cwd, { phase: "audit" });
  const prompt = `${templateResult.template}\n\nGit diff:\n\`\`\`\n${truncateDiff(diff)}\n\`\`\``;

  const startedAt = Date.now();
  let toolUseCount = 0;
  let toolResultCount = 0;
  logger.info("self-review:request", "Self-review request started", {
    diffLength: diff.length,
    model,
  });

  const handle = agent.execute(prompt, {
    cwd,
    model,
    skipPermissions: false,
    onTool: (event) => {
      if (event.kind === "use") toolUseCount += 1;
      if (event.kind === "result") toolResultCount += 1;
      const input = event.input !== undefined ? truncate(toDisplay(event.input), TOOL_INPUT_LIMIT) : undefined;
      const output = event.output !== undefined ? truncate(toDisplay(event.output), TOOL_OUTPUT_LIMIT) : undefined;
      logger.debug("self-review:tool", "Self-review tool event", {
        kind: event.kind,
        name: event.name,
        id: event.id,
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
      });
    },
  });
  const result = await handle.promise;
  const durationMs = Date.now() - startedAt;
  logger.info("self-review:response", "Self-review response complete", {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs,
    stdoutLength: result.stdout.length,
    stderrLength: result.stderr.length,
    toolUseCount,
    toolResultCount,
  });
  const output = result.stdout;
  if (result.timedOut) {
    logger.error("self-review:timeout", "Self-review agent timed out", { durationMs });
    throw new Error("Review agent timed out");
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr ? truncate(result.stderr, 2000) : "";
    logger.error("self-review:exit", "Self-review agent exited non-zero", {
      exitCode: result.exitCode,
      stderr,
    });
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
