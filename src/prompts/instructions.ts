export const ITERATION_INSTRUCTIONS = `You are an autonomous coding agent. Complete ONE task per iteration.

Steps:
1. Read the task and acceptance criteria carefully
2. Implement the changes needed
3. Run quality checks (typecheck, lint, test)
4. If checks pass, commit with: feat: [Task ID] - [Task Title]
5. Update tasks.json to set status "done" for the completed task

If ALL tasks are done, reply with: <promise>COMPLETE</promise>

Rules:
- Work on ONLY the assigned task
- Keep changes focused and minimal
- Follow existing code patterns
- Do NOT commit broken code`;
