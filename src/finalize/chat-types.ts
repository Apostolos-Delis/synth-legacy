export interface ChatOption {
  label: string;
  description: string;
  value: string;
}

export interface FinalizeMessage {
  role: "user" | "assistant" | "system";
  content: string;
  options?: ChatOption[];
}

export type ReviewIssueSeverity = "critical" | "major" | "minor";

export interface ReviewIssue {
  severity: ReviewIssueSeverity;
  category: string;
  description: string;
  suggestedFix?: string;
}

export type FixTaskStatus = "proposed" | "accepted" | "rejected" | "modified";

export interface FixTask {
  id: string;
  description: string;
  acceptanceCriteria: string[];
  priority: 1 | 2 | 3;
  status: FixTaskStatus;
  sourceIssue: ReviewIssue;
}

export type FinalizePhase =
  | "auditing"
  | "discussing"
  | "collecting-fixes"
  | "executing-fixes"
  | "creating-pr"
  | "complete";

export interface CompletionSummary {
  prUrl: string | null;
  tasksCompleted: number;
  totalTasks: number;
  commitCount: number;
  fixesApplied: number;
  durationMs: number;
}

export interface FinalizeChatState {
  phase: FinalizePhase;
  messages: FinalizeMessage[];
  issues: ReviewIssue[];
  fixes: FixTask[];
}
