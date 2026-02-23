import type { TaskFile } from "../tasks/types.js";
import { spawn } from "../utils/process.js";
import type { ReviewFinding } from "./review.js";
import { formatAuditForPr, type AuditResult } from "./audit.js";

export function generatePrBody(
  taskFile: TaskFile,
  prdContent: string | null,
  findings: ReviewFinding[],
  diffStats: string,
  audit?: AuditResult | null,
): string {
  const sections: string[] = [];

  // Context
  sections.push("## Context\n");
  sections.push(taskFile.description);
  if (prdContent) {
    // Extract problem statement from PRD
    const problemMatch = prdContent.match(
      /## Problem Statement\s*\n\s*([\s\S]*?)(?=\n## )/,
    );
    if (problemMatch) {
      sections.push(`\n${problemMatch[1].trim()}`);
    }
  }

  // Task summary
  sections.push("\n## Changes\n");
  for (const task of taskFile.tasks.filter((t) => t.status === "done")) {
    sections.push(`- **${task.id}**: ${task.title}`);
  }

  // Test plan
  const verifications = taskFile.tasks
    .flatMap((t) => t.verification ?? [])
    .filter((v) => v.type === "command");
  if (verifications.length > 0) {
    sections.push("\n## Test Plan\n");
    for (const v of verifications) {
      sections.push(`- \`${v.value}\``);
    }
  }

  // Review notes
  const warnings = findings.filter((f) => f.severity === "warning");
  if (warnings.length > 0) {
    sections.push("\n## Review Notes\n");
    for (const w of warnings) {
      sections.push(`- [${w.perspective}] ${w.message}`);
    }
  }

  // PRD Audit
  if (audit) {
    sections.push("\n" + formatAuditForPr(audit));
  }

  // Mitigation
  sections.push("\n## Mitigation\n");
  sections.push(`Diff stats: ${diffStats}`);
  sections.push("\n## Checklist\n");
  sections.push("- [ ] Quality checks pass");
  sections.push("- [ ] No secrets committed");
  sections.push("- [ ] Tests cover new functionality");

  return sections.join("\n");
}

/**
 * Classify a raw CLI/API error into a user-friendly message.
 * Strips GraphQL noise and identifies common failure modes.
 */
export function classifyPrError(raw: string): string {
  const lower = raw.toLowerCase();

  // gh CLI not installed
  if (lower.includes("command not found") || lower.includes("not found: gh") || lower.includes("no such file")) {
    return "GitHub CLI (gh) is not installed. Install it with: brew install gh";
  }

  // Not authenticated
  if (lower.includes("not logged") || lower.includes("auth login") || lower.includes("authentication") || lower.includes("401")) {
    return "Not authenticated with GitHub. Run: gh auth login";
  }

  // PR already exists
  if (lower.includes("already exists") || lower.includes("a pull request already exists")) {
    return "A pull request already exists for this branch";
  }

  // Repository not found / no remote
  if (lower.includes("repository not found") || lower.includes("could not resolve") || lower.includes("no such remote") || /\b404\b/.test(lower)) {
    return "Could not find the GitHub repository. Check that the remote is configured correctly";
  }

  // Network errors
  if (lower.includes("could not connect") || lower.includes("network") || lower.includes("timeout") || lower.includes("timed out")) {
    return "Network error — could not connect to GitHub. Check your internet connection";
  }

  // Permission denied
  if (lower.includes("permission denied") || lower.includes("403") || lower.includes("forbidden")) {
    return "Permission denied. You may not have push access to this repository";
  }

  // Strip GraphQL error wrapping to extract a clean message
  const graphqlMatch = raw.match(/GraphQL:\s*(.+?)(?:\s*\(|$)/i);
  if (graphqlMatch) {
    return graphqlMatch[1].trim();
  }

  // Fallback: return a cleaned-up version (strip ANSI codes, trim)
  const cleaned = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
  // Limit length to avoid dumping walls of text
  return cleaned.length > 200 ? cleaned.slice(0, 200) + "..." : cleaned;
}

export async function createPr(
  cwd: string,
  branch: string,
  title: string,
  body: string,
): Promise<{ url: string; number: number }> {
  // Push
  const pushHandle = spawn({
    cmd: ["git", "push", "--set-upstream", "origin", branch],
    cwd,
  });
  const pushResult = await pushHandle.promise;
  if (pushResult.exitCode !== 0) {
    throw new Error(classifyPrError(pushResult.stderr || "Push failed"));
  }

  // Create PR
  const prHandle = spawn({
    cmd: [
      "gh",
      "pr",
      "create",
      "--title",
      title,
      "--body",
      body,
    ],
    cwd,
  });
  const prResult = await prHandle.promise;
  if (prResult.exitCode !== 0) {
    throw new Error(classifyPrError(prResult.stderr || "PR creation failed"));
  }

  const url = prResult.stdout.trim();
  const numberMatch = url.match(/\/pull\/(\d+)/);
  return {
    url,
    number: numberMatch ? parseInt(numberMatch[1], 10) : 0,
  };
}

export async function getDiffStats(cwd: string, base: string): Promise<string> {
  const handle = spawn({
    cmd: ["git", "diff", "--stat", `${base}...HEAD`],
    cwd,
  });
  const result = await handle.promise;
  return result.stdout.trim().split("\n").pop() ?? "no changes";
}
