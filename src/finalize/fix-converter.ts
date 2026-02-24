import type { FixTask } from "./chat-types.js";
import type { Task } from "../tasks/types.js";
import { buildFixPrompt } from "./orchestrator.js";

const PRIORITY_MAP: Record<1 | 2 | 3, 1 | 2 | 3 | 4 | 5> = {
  1: 1,
  2: 3,
  3: 5,
};

export function fixTasksToTasks(fixes: FixTask[], cwd: string): Task[] {
  return fixes.map((fix) => ({
    id: fix.id,
    title: fix.description.slice(0, 120),
    description: buildFixPrompt(fix, cwd),
    acceptanceCriteria: fix.acceptanceCriteria,
    priority: PRIORITY_MAP[fix.priority] ?? 3,
    status: "open" as const,
    iterationCount: 0,
  }));
}
