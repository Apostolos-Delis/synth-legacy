export interface Task {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  criteriaCompleted?: boolean[];
  verification?: { type: "command" | "regex"; value: string }[];
  priority: 1 | 2 | 3 | 4 | 5;
  status: "open" | "in_progress" | "done" | "failed" | "skipped";
  dependsOn?: string[];
  notes?: string;
  iterationCount: number;
}

export interface TaskFile {
  project: string;
  branchName: string;
  description: string;
  tasks: Task[];
}
