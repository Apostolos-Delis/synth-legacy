import type { AgentAdapter } from "../agents/types.js";

export type AuditVerdict = "pass" | "warn" | "fail";

export type FindingSeverity = "critical" | "high" | "medium" | "low";

export interface StoryAudit {
  story: string;
  verdict: AuditVerdict;
  notes: string;
}

export interface AuditFinding {
  severity: FindingSeverity;
  file: string;
  line: number;
  description: string;
  suggestedFix: string;
}

export interface AuditResult {
  overall: AuditVerdict;
  stories: StoryAudit[];
  findings: AuditFinding[];
  summary: string;
}

const AUDIT_PROMPT = `You are auditing code changes against a Product Requirements Document (PRD).

Compare the git diff against the PRD goals and user stories below. For each user story in the PRD, determine whether the code changes satisfy it. Also identify any bugs, regressions, or missing tests in the changed code.

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
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "file": "path/to/file.ts",
      "line": 42,
      "description": "what the issue is and why it matters",
      "suggestedFix": "how to fix it"
    }
  ],
  "summary": "one paragraph summary of the audit"
}

Rules:
- "pass" = story is fully addressed by the changes
- "warn" = story is partially addressed or has minor gaps
- "fail" = story is not addressed or has significant gaps
- "overall" is "pass" if all stories pass, "warn" if any warn, "fail" if any fail
- Order findings by severity: critical first, then high, medium, low
- Prioritize bugs, regressions, and missing tests over style issues
- Each finding MUST include file path, line number, description, and suggested fix
- If no issues are found, return an empty findings array and state in the summary that the changes are clean`;

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
    return { overall: "warn", stories: [], findings: [], summary: "Could not parse audit output" };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { overall: "warn", stories: [], findings: [], summary: "Invalid audit response" };
    }
    return {
      overall: parsed.overall ?? "warn",
      stories: Array.isArray(parsed.stories) ? parsed.stories : [],
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      summary: parsed.summary ?? "",
    };
  } catch {
    return { overall: "warn", stories: [], findings: [], summary: "Failed to parse audit JSON" };
  }
}

export function formatAuditReport(audit: AuditResult): string {
  const verdictIcon = (v: AuditVerdict) =>
    v === "pass" ? "PASS" : v === "warn" ? "WARN" : "FAIL";

  const severityLabel = (s: FindingSeverity) => s.toUpperCase();

  const lines: string[] = [];
  lines.push(`PRD Audit: ${verdictIcon(audit.overall)}`);
  lines.push("");

  for (const s of audit.stories) {
    lines.push(`  [${verdictIcon(s.verdict)}] ${s.story}`);
    if (s.notes) lines.push(`         ${s.notes}`);
  }

  if (audit.findings.length > 0) {
    lines.push("");
    lines.push("Findings:");
    for (const f of audit.findings) {
      lines.push(`  [${severityLabel(f.severity)}] ${f.file}:${f.line} — ${f.description}`);
      if (f.suggestedFix) lines.push(`           Fix: ${f.suggestedFix}`);
    }
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

  const severityIcon = (s: FindingSeverity) =>
    s === "critical" ? "\u{1F534}" : s === "high" ? "\u{1F7E0}" : s === "medium" ? "\u{1F7E1}" : "\u{1F535}";

  const lines: string[] = [];
  lines.push("## PRD Audit\n");
  lines.push(`**Overall**: ${verdictIcon(audit.overall)} ${audit.overall.toUpperCase()}\n`);
  lines.push("| Story | Verdict | Notes |");
  lines.push("|-------|---------|-------|");
  for (const s of audit.stories) {
    lines.push(`| ${s.story} | ${verdictIcon(s.verdict)} ${s.verdict} | ${s.notes} |`);
  }

  if (audit.findings.length > 0) {
    lines.push("\n### Findings\n");
    lines.push("| Severity | Location | Description | Suggested Fix |");
    lines.push("|----------|----------|-------------|---------------|");
    for (const f of audit.findings) {
      lines.push(`| ${severityIcon(f.severity)} ${f.severity} | \`${f.file}:${f.line}\` | ${f.description} | ${f.suggestedFix} |`);
    }
  }

  if (audit.summary) {
    lines.push(`\n${audit.summary}`);
  }
  return lines.join("\n");
}
