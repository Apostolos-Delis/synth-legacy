import type { SessionPaths } from "../sessions/types.js";
import type { TaskFile } from "../tasks/types.js";
import { spawn } from "../utils/process.js";
import { loadTasks } from "../tasks/store.js";
import { fileExists } from "../utils/fs.js";

const MAX_DIFF_SIZE = 50_000;

export interface AuditContext {
  diff: string;
  taskFile: TaskFile | null;
  taskSummary: string;
  baseBranch: string;
}

export async function buildAuditContext(
  sessionPaths: SessionPaths,
  cwd: string,
  baseBranch: string,
): Promise<AuditContext> {
  // Gather git diff
  const diffHandle = spawn({
    cmd: ["git", "diff", `${baseBranch}...HEAD`],
    cwd,
  });
  const diffResult = await diffHandle.promise;
  const diff = diffResult.exitCode === 0 ? diffResult.stdout : "";

  // Load task file
  let taskFile: TaskFile | null = null;
  const tasksExist = await fileExists(sessionPaths.tasks);
  if (tasksExist) {
    try {
      taskFile = await loadTasks(sessionPaths.tasks);
    } catch {
      taskFile = null;
    }
  }

  // Build task summary
  const taskSummary = formatTaskSummary(taskFile);

  return { diff, taskFile, taskSummary, baseBranch };
}

function formatTaskSummary(taskFile: TaskFile | null): string {
  if (!taskFile || taskFile.tasks.length === 0) {
    return "No tasks found.";
  }

  const lines: string[] = [`Project: ${taskFile.project}`];
  if (taskFile.description) {
    lines.push(`Description: ${taskFile.description}`);
  }
  lines.push("");

  for (const task of taskFile.tasks) {
    const statusIcon =
      task.status === "done"
        ? "[done]"
        : task.status === "failed"
          ? "[FAILED]"
          : task.status === "in_progress"
            ? "[in progress]"
            : task.status === "skipped"
              ? "[skipped]"
              : "[open]";
    lines.push(`${statusIcon} ${task.id}: ${task.title}`);
  }

  const done = taskFile.tasks.filter((t) => t.status === "done").length;
  const total = taskFile.tasks.length;
  lines.push("");
  lines.push(`Progress: ${done}/${total} tasks completed`);

  return lines.join("\n");
}

export function buildAuditSystemPrompt(): string {
  return `You are an expert code reviewer conducting an interactive audit of code changes. You review code in a conversational setting — the developer can ask follow-up questions, request clarification, or discuss your findings.

Your review style:
- Be direct and specific. Reference exact file names and line numbers (e.g., \`src/utils/auth.ts:42\`) for every finding.
- Categorize each finding by severity: **critical**, **high**, **medium**, or **low**.
- Order findings by severity: all critical findings first, then high, then medium, then low.
- Explain WHY something is an issue, not just WHAT is wrong.
- For each finding, provide: severity, file/line reference, description, and a suggested fix.
- Acknowledge good patterns and well-written code, not just problems.
- If the code looks clean, explicitly state: "No issues found. The changes are clean and well-structured." Do NOT invent issues or pad the review with noise.

Prioritization (review in this order):
1. **Bugs and regressions** — logic errors, broken behavior, null/undefined risks
2. **Missing tests** — untested code paths, missing edge case coverage
3. **Security** — injection risks, secrets exposure, input validation gaps
4. **Spec compliance** — do changes satisfy the task requirements?
5. **Code quality** — structure, readability, error handling, DRY
6. **Style** — naming, formatting, conventions (lowest priority — mention only if egregious)

Review dimensions:
1. **Code Quality**: Structure, readability, naming, DRY, error handling
2. **Pattern Consistency**: Does new code match existing project conventions?
3. **Security**: Input validation, injection risks, secrets exposure, OWASP concerns
4. **Spec Compliance**: Do changes satisfy the task requirements and acceptance criteria?
5. **Test Coverage**: Are there tests? Do they cover edge cases and error paths?

When responding conversationally:
- Keep initial review structured but readable (not raw JSON).
- Use markdown formatting for clarity.
- Be open to pushback — if the developer explains a choice, accept it if reasonable.
- Stay focused on the code changes; don't review unrelated code.

## Follow-up Q&A Flow

After the initial audit, ask focused follow-up questions **one topic at a time**. Drill into areas that need clarification or have potential issues.

When asking a question, you may provide 2-4 multiple-choice options using these markers:

[OPTION]Option label|Brief description of this choice[/OPTION]
[OPTION*]Recommended label|Brief description — this is the recommended choice[/OPTION]

Use [OPTION*] (with asterisk) to mark the recommended/preferred option. Only mark one option as recommended per question.

Example:
I noticed the error handling in \`processOrder\` doesn't cover network timeouts. How would you like to handle this?

[OPTION*]Add retry logic|Wrap the call in a retry with exponential backoff[/OPTION]
[OPTION]Propagate error|Let the caller handle timeout errors[/OPTION]
[OPTION]Skip for now|This is acceptable risk for the current scope[/OPTION]

Rules for options:
- Include 2-4 options per question (never more than 4)
- Each option has a short label and a brief description separated by |
- Options should represent meaningfully different approaches
- Not every question needs options — use them when there are clear distinct choices
- Use [OPTION*] for the recommended choice when one is clearly preferable

## Multi-Question Batching

When you have 2-3 related questions on different topics, batch them using [QUESTION] markers:

[QUESTION]Error recovery approach[/QUESTION]
[OPTION*]Add retry logic|Wrap the call in a retry with exponential backoff[/OPTION]
[OPTION]Propagate error|Let the caller handle timeout errors[/OPTION]

[QUESTION]Logging level[/QUESTION]
[OPTION]Debug|Log at debug level for development[/OPTION]
[OPTION*]Info|Log at info level for production visibility[/OPTION]

Rules for question groups:
- Batch 2-3 related questions maximum
- Each [QUESTION] marker should have a concise header (not a full sentence)
- Place [OPTION] markers directly after the [QUESTION] they belong to
- Don't overuse — single questions don't need [QUESTION] markers

## Proposing Fixes

When you identify an actionable fix during the review, propose it using these markers:

[FIX]Concise description of the fix to apply[/FIX]

Example:
I noticed the error handler in \`processOrder\` swallows exceptions silently.

[FIX]Add error logging to processOrder catch block[/FIX]

Rules for fixes:
- Each [FIX] marker describes one discrete, actionable change
- Be specific enough that a developer could implement it from the description alone
- You can propose fixes at any point during the review discussion
- Multiple fixes can appear in a single message

When you have no more concerns or questions, end your message with:

[REVIEW_COMPLETE]

This signals the review discussion is finished and triggers the next phase.`;
}

export function buildInitialAuditPrompt(context: AuditContext): string {
  const parts: string[] = [];

  parts.push("Please review the following code changes.\n");

  // Task summary
  if (context.taskSummary !== "No tasks found.") {
    parts.push("## Task Context\n");
    parts.push(context.taskSummary);
    parts.push("");
  }

  // Diff (truncated)
  if (context.diff.trim()) {
    const truncatedDiff =
      context.diff.length > MAX_DIFF_SIZE
        ? context.diff.slice(0, MAX_DIFF_SIZE) +
          `\n\n[... diff truncated at ${MAX_DIFF_SIZE} characters — ${context.diff.length - MAX_DIFF_SIZE} characters omitted]`
        : context.diff;

    parts.push("## Git Diff\n");
    parts.push("```diff");
    parts.push(truncatedDiff);
    parts.push("```\n");
  } else {
    parts.push("## Git Diff\n");
    parts.push("No changes detected (empty diff).\n");
  }

  // Review instructions
  parts.push("## Review Instructions\n");
  parts.push(
    "Produce a structured review covering these dimensions:",
  );
  parts.push("1. **Code Quality** — structure, readability, error handling");
  parts.push("2. **Pattern Consistency** — alignment with project conventions");
  parts.push("3. **Security** — validation, injection risks, secrets");
  parts.push("4. **Spec Compliance** — do changes satisfy the tasks listed above?");
  parts.push("5. **Test Coverage** — presence and quality of tests\n");
  parts.push(
    "Categorize each finding as **critical**, **high**, **medium**, or **low**.\n\n" +
      "Structure your review as:\n" +
      "1. Brief summary (2-3 sentences)\n" +
      "2. Findings ordered by severity (critical first, then high, medium, low)\n" +
      "   - Each finding must include: severity, file:line reference, description, and suggested fix\n" +
      "3. Overall assessment\n\n" +
      "Prioritize bugs, regressions, and missing tests over style issues. " +
      "If no issues are found, explicitly state that the changes are clean — do not fill the review with noise.\n\n" +
      "For each actionable issue found, propose a fix using [FIX]description[/FIX] markers.\n\n" +
      "After the assessment, ask your first follow-up question about the most important topic. " +
      "Focus on one topic at a time. You may include [OPTION]label|description[/OPTION] markers " +
      "(or [OPTION*]label|description[/OPTION] for the recommended choice) " +
      "if the question has clear distinct choices.",
  );

  return parts.join("\n");
}
