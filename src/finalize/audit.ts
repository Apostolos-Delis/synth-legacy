import type { AgentAdapter } from "../agents/types.js";

export type AuditVerdict = "pass" | "warn" | "fail";

export interface StoryAudit {
  story: string;
  verdict: AuditVerdict;
  notes: string;
}

export interface AuditResult {
  overall: AuditVerdict;
  stories: StoryAudit[];
  summary: string;
}

const AUDIT_PROMPT = `You are auditing code changes against a Product Requirements Document (PRD).

Compare the git diff against the PRD goals and user stories below. For each user story in the PRD, determine whether the code changes satisfy it.

Output ONLY a JSON object (no markdown fences, no explanation):

{
  "overall": "pass|warn|fail",
  "stories": [
    {
      "story": "user story title or ID",
      "verdict": "pass|warn|fail",
      "notes": "brief explanation"
    }
  ],
  "summary": "one paragraph summary of the audit"
}

Rules:
- "pass" = story is fully addressed by the changes
- "warn" = story is partially addressed or has minor gaps
- "fail" = story is not addressed or has significant gaps
- "overall" is "pass" if all stories pass, "warn" if any warn, "fail" if any fail`;

export async function prdAudit(
  agent: AgentAdapter,
  prd: string,
  diff: string,
  cwd: string,
  model?: string,
): Promise<AuditResult> {
  const prompt = `${AUDIT_PROMPT}\n\nPRD:\n\`\`\`\n${prd.slice(0, 30000)}\n\`\`\`\n\nGit diff:\n\`\`\`\n${diff.slice(0, 50000)}\n\`\`\``;

  let output = "";
  const handle = agent.execute(prompt, {
    cwd,
    model,
    skipPermissions: false,
    onStdout: (chunk) => {
      output += chunk;
    },
  });
  await handle.promise;

  const fencedMatch = output.match(/```json\s*(\{[\s\S]*?\})\s*```/);
  const raw = fencedMatch?.[1] ?? output.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) {
    return { overall: "warn", stories: [], summary: "Could not parse audit output" };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { overall: "warn", stories: [], summary: "Invalid audit response" };
    }
    return {
      overall: parsed.overall ?? "warn",
      stories: Array.isArray(parsed.stories) ? parsed.stories : [],
      summary: parsed.summary ?? "",
    };
  } catch {
    return { overall: "warn", stories: [], summary: "Failed to parse audit JSON" };
  }
}

export function formatAuditReport(audit: AuditResult): string {
  const verdictIcon = (v: AuditVerdict) =>
    v === "pass" ? "PASS" : v === "warn" ? "WARN" : "FAIL";

  const lines: string[] = [];
  lines.push(`PRD Audit: ${verdictIcon(audit.overall)}`);
  lines.push("");

  for (const s of audit.stories) {
    lines.push(`  [${verdictIcon(s.verdict)}] ${s.story}`);
    if (s.notes) lines.push(`         ${s.notes}`);
  }

  if (audit.summary) {
    lines.push("");
    lines.push(audit.summary);
  }

  return lines.join("\n");
}

export function formatAuditForPr(audit: AuditResult): string {
  const verdictIcon = (v: AuditVerdict) =>
    v === "pass" ? "\u2705" : v === "warn" ? "\u26a0\ufe0f" : "\u274c";

  const lines: string[] = [];
  lines.push("## PRD Audit\n");
  lines.push(`**Overall**: ${verdictIcon(audit.overall)} ${audit.overall.toUpperCase()}\n`);
  lines.push("| Story | Verdict | Notes |");
  lines.push("|-------|---------|-------|");
  for (const s of audit.stories) {
    lines.push(`| ${s.story} | ${verdictIcon(s.verdict)} ${s.verdict} | ${s.notes} |`);
  }
  if (audit.summary) {
    lines.push(`\n${audit.summary}`);
  }
  return lines.join("\n");
}
