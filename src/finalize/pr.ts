import type { TaskFile } from "../tasks/types.js";
import type { FinalizeError } from "./chat-types.js";
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

// Shared error classification patterns used by both classifyPrError and classifyPrErrorDetail.
// Each entry is tested in order; the first match wins.
interface ErrorPattern {
  test: (lower: string) => boolean;
  errorType: string;
  message: string;
  suggestedFix: string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    test: (l) => l.includes("command not found") || l.includes("not found: gh") || l.includes("no such file or directory: gh"),
    errorType: "gh-not-installed",
    message: "GitHub CLI (gh) is not installed. Install it with: brew install gh",
    suggestedFix: "Install the GitHub CLI: brew install gh",
  },
  {
    test: (l) => l.includes("not logged") || l.includes("auth login") || l.includes("authentication required") || l.includes("authentication failed") || l.includes("401"),
    errorType: "auth-failed",
    message: "Not authenticated with GitHub. Run: gh auth login",
    suggestedFix: "Authenticate with GitHub: gh auth login",
  },
  {
    test: (l) => l.includes("already exists") || l.includes("a pull request already exists"),
    errorType: "pr-exists",
    message: "A pull request already exists for this branch",
    suggestedFix: "A PR already exists for this branch. Use gh pr view to see it",
  },
  {
    test: (l) => l.includes("repository not found") || l.includes("could not resolve") || l.includes("no such remote") || /\b404\b/.test(l),
    errorType: "repo-not-found",
    message: "Could not find the GitHub repository. Check that the remote is configured correctly",
    suggestedFix: "Check that the git remote is configured correctly: git remote -v",
  },
  {
    test: (l) => l.includes("could not connect") || l.includes("network") || l.includes("timeout") || l.includes("timed out"),
    errorType: "network-error",
    message: "Network error — could not connect to GitHub. Check your internet connection",
    suggestedFix: "Check your internet connection and try again",
  },
  {
    test: (l) => l.includes("permission denied") || l.includes("403") || l.includes("forbidden"),
    errorType: "permission-denied",
    message: "Permission denied. You may not have push access to this repository",
    suggestedFix: "You may not have push access. Check repository permissions",
  },
  {
    test: (l) => l.includes("protected branch") || l.includes("required status check") || l.includes("push declined"),
    errorType: "protected-branch",
    message: "Push was rejected by branch protection rules. Push to a feature branch instead",
    suggestedFix: "Push was rejected by branch protection rules. Push to a feature branch instead",
  },
];

function matchErrorPattern(raw: string): ErrorPattern | null {
  const lower = raw.toLowerCase();
  return ERROR_PATTERNS.find((p) => p.test(lower)) ?? null;
}

/**
 * Classify a raw CLI/API error into a user-friendly message.
 * Strips GraphQL noise and identifies common failure modes.
 */
export function classifyPrError(raw: string): string {
  const matched = matchErrorPattern(raw);
  if (matched) return matched.message;

  // Strip GraphQL error wrapping to extract a clean message
  const graphqlMatch = raw.match(/GraphQL:\s*(.+?)(?:\s*\(|$)/i);
  if (graphqlMatch) return graphqlMatch[1].trim();

  // Fallback: return a cleaned-up version (strip ANSI codes, trim)
  const cleaned = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
  return cleaned.length > 200 ? cleaned.slice(0, 200) + "..." : cleaned;
}

/**
 * Return structured error detail for TUI inline display.
 */
export function classifyPrErrorDetail(raw: string): FinalizeError {
  const matched = matchErrorPattern(raw);
  if (matched) {
    return { errorType: matched.errorType, rawOutput: raw, suggestedFix: matched.suggestedFix };
  }
  return { errorType: "unknown", rawOutput: raw, suggestedFix: "Review the error output above and retry, or exit and resolve manually" };
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
