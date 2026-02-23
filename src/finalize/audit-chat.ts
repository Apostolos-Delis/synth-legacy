import type { PlanPaths } from "../plans/types.js";
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
  planPaths: PlanPaths,
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
  const tasksExist = await fileExists(planPaths.tasks);
  if (tasksExist) {
    try {
      taskFile = await loadTasks(planPaths.tasks);
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
- Be direct and specific. Reference file names and line ranges when possible.
- Categorize each issue by severity: critical, major, or minor.
- Explain WHY something is an issue, not just WHAT is wrong.
- Suggest concrete fixes when possible.
- Acknowledge good patterns and well-written code, not just problems.
- If the code looks clean, say so — don't invent issues.

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
- Stay focused on the code changes; don't review unrelated code.`;
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
    "Categorize each issue as **critical**, **major**, or **minor**. Start with a brief summary, then list findings grouped by dimension. End with an overall assessment.",
  );

  return parts.join("\n");
}
