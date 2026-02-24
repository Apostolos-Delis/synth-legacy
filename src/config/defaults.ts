import type { SynthConfig } from "./types.js";

export const DEFAULT_CONFIG: SynthConfig = {
  project: {
    name: "",
    branch: "",
    base_branch: "main",
  },
  agent: {
    name: "claude",
    model: "opus",
    timeout: 600_000,
    skip_permissions: true,
  },
  execution: {
    max_iterations: 30,
    iteration_delay: 2000,
    auto_commit: true,
  },
  guardrails: {
    max_consecutive_failures: 3,
    backpressure_commands: [],
  },
  finalize: {
    auto_format: true,
    split_commits: true,
    self_review: true,
    create_pr: true,
  },
  parallel: {
    max_workers: 8,
    ai_conflict_resolution: true,
    max_requeue_count: 1,
  },
  tui: {
    theme: "tokyonight",
  },
  notifications: {
    enabled: true,
  },
};
