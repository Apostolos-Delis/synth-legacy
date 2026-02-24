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
    max_iterations: 20,
    iteration_delay: 2000,
    auto_commit: true,
    prevent_sleep: true,
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
    enabled: true,
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

export const PERSONAL_CONFIG_TEMPLATE = `# ~/.synth/config.toml — Personal synth preferences
# These apply to all projects. Project synth.toml overrides these values.

[agent]
name = "claude"              # "claude" | "codex"
model = "opus"
timeout = 600000             # 10 min per iteration

[tui]
# theme = "tokyonight"      # Built-in: tokyonight, onedark, catppuccin, dracula, solarized, nord, gruvbox
# spinner = "dots"           # Presets: dots, braille, line, moon, bounce, arc, box, arrows

[parallel]
enabled = true
max_workers = 8
ai_conflict_resolution = true

[notifications]
enabled = true
`;
