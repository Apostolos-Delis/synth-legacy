export interface SynthConfig {
  project: {
    name: string;
    branch: string;
    base_branch: string;
  };
  agent: {
    name: "claude" | "codex";
    model?: string;
    timeout: number;
    skip_permissions: boolean;
    fallback?: {
      name: "claude" | "codex";
    };
  };
  execution: {
    max_iterations: number;
    iteration_delay: number;
    auto_commit: boolean;
    prevent_sleep?: boolean;
  };
  guardrails: {
    max_consecutive_failures: number;
    backpressure_commands: string[];
  };
  finalize: {
    auto_format: boolean;
    split_commits: boolean;
    self_review: boolean;
    create_pr: boolean;
    pr_template?: string;
  };
  tui?: {
    theme?: string;
    spinner?: string;
  };
  parallel?: {
    enabled?: boolean;
    max_workers?: number;
    ai_conflict_resolution?: boolean;
    max_requeue_count?: number;
    stagger_delay_ms?: number;
  };
  notifications?: {
    enabled?: boolean;
  };
}
