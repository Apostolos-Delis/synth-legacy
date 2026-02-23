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
    throw new Error(`Push failed: ${pushResult.stderr}`);
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
    throw new Error(`PR creation failed: ${prResult.stderr}`);
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
