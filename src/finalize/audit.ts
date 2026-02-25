import type { AgentAdapter } from "../agents/types.js";
import { loadTemplate } from "../templates/index.js";
import { truncateDiff } from "../utils/git.js";

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

export function validateFinding(obj: unknown): AuditFinding | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.file !== "string" || typeof o.description !== "string" || typeof o.severity !== "string") return null;
  return {
    severity: o.severity as FindingSeverity,
    file: o.file,
    line: typeof o.line === "number" ? o.line : Number(o.line) || 0,
    description: o.description,
    suggestedFix: typeof o.suggestedFix === "string" ? o.suggestedFix : "",
  };
}

export async function prdAudit(
  agent: AgentAdapter,
  prd: string,
  diff: string,
  cwd: string,
  model?: string,
): Promise<AuditResult> {
  const templateResult = await loadTemplate(agent.name, cwd, { phase: "audit" });
  const prompt = `${templateResult.template}\n\nPRD:\n\`\`\`\n${prd.slice(0, 30000)}\n\`\`\`\n\nGit diff:\n\`\`\`\n${truncateDiff(diff)}\n\`\`\``;

  const handle = agent.execute(prompt, {
    cwd,
    model,
    skipPermissions: false,
  });
  const result = await handle.promise;
  const output = result.stdout;
  if (result.timedOut) {
    throw new Error("Audit agent timed out");
  }
  if (result.exitCode !== 0) {
    throw new Error(`Audit agent exited with code ${result.exitCode}: ${result.stderr}`);
  }

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
      findings: Array.isArray(parsed.findings)
        ? parsed.findings.map(validateFinding).filter((f: AuditFinding | null): f is AuditFinding => f !== null)
        : [],
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
