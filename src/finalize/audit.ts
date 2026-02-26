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
  const logger = getLogger();
  const templateResult = await loadTemplate(agent.name, cwd, { phase: "audit" });
  const prompt = `${templateResult.template}\n\nPRD:\n\`\`\`\n${prd.slice(0, 30000)}\n\`\`\`\n\nGit diff:\n\`\`\`\n${truncateDiff(diff)}\n\`\`\``;

  const startedAt = Date.now();
  let toolUseCount = 0;
  let toolResultCount = 0;
  logger.info("audit:request", "Audit request started", {
    prdLength: prd.length,
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
      logger.debug("audit:tool", "Audit tool event", {
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
  logger.info("audit:response", "Audit response complete", {
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
    logger.error("audit:timeout", "Audit agent timed out", { durationMs });
    throw new Error("Audit agent timed out");
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr ? truncate(result.stderr, 2000) : "";
    logger.error("audit:exit", "Audit agent exited non-zero", {
      exitCode: result.exitCode,
      stderr,
    });
    throw new Error(`Audit agent exited with code ${result.exitCode}: ${result.stderr}`);
  }

  const fencedMatch = output.match(/```json\s*(\{[\s\S]*?\})\s*```/);
  const raw = fencedMatch?.[1] ?? output.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) {
    logger.warn("audit:parse-failed", "Audit output missing JSON payload");
    return { overall: "warn", stories: [], findings: [], summary: "Could not parse audit output" };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      logger.warn("audit:parse-failed", "Audit output invalid JSON object");
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
    logger.warn("audit:parse-failed", "Audit output JSON parse error");
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
