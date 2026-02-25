# Configuration

Synth is configured via `synth.toml` in your project root. Run `synth init` to create one from the template, or `synth config` to dump the resolved configuration as JSON.

## Configuration Layers

Configuration is resolved in order (later layers override earlier):

1. **Defaults** (`src/config/defaults.ts`) — Built-in sensible defaults
2. **File** (`synth.toml`) — Project-specific overrides
3. **Programmatic** — CLI flags and runtime overrides

The loader performs a deep merge, so you only need to specify the fields you want to override.

## Full Reference

### `[project]`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | `""` (auto-detected) | Project name. If empty, detected from the directory name |
| `branch` | string | `""` | Feature branch name for the session |
| `base_branch` | string | `"main"` | Base branch for diffs and PR target |

### `[agent]`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `"claude"` \| `"codex"` | `"claude"` | Primary AI agent to use |
| `model` | string | `"opus"` | Model name passed to the agent CLI |
| `timeout` | number (ms) | `600000` (10 min) | Per-iteration timeout. Agent is SIGTERM'd if exceeded |
| `skip_permissions` | boolean | `true` | Skip agent permission prompts for file/command access |

### `[agent.fallback]`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `"claude"` \| `"codex"` | _(none)_ | Fallback agent used when the primary is rate-limited |

### `[execution]`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_iterations` | number | `20` | Maximum iterations before the engine pauses. Use `synth resume` to continue |
| `iteration_delay` | number (ms) | `2000` | Delay between iterations (helps avoid rate limits) |
| `auto_commit` | boolean | `true` | Auto-commit via `git add -u && git commit` after each successful task |

### `[guardrails]`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_consecutive_failures` | number | `3` | Circuit breaker threshold. After N consecutive failures, the engine blocks |
| `backpressure_commands` | string[] | `[]` | Shell commands that must exit 0 after each iteration (e.g. typecheck, lint) |

### `[finalize]`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auto_format` | boolean | `true` | Detect and run code formatters before PR |
| `split_commits` | boolean | `true` | Split changes into categorized commits (feat, test, docs, etc.) |
| `self_review` | boolean | `true` | AI-powered code review from 3 perspectives |
| `create_pr` | boolean | `true` | Create GitHub PR via `gh` CLI |
| `pr_template` | string | _(none)_ | Path to a custom PR template file |

### `[tui]`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `theme` | string | `"tokyonight"` | Built-in theme name, custom theme name, or absolute path to a `.toml` theme file |
| `spinner` | string | _(theme default)_ | Spinner preset: `dots`, `braille`, `line`, `moon`, `bounce`, `arc`, `box`, `arrows` |
| `show_tool_logs` | boolean | `true` | Show tool inputs/outputs in TUI output panes |

## Example Configuration

```toml
[project]
name = "my-app"
branch = "feature/add-auth"
base_branch = "main"

[agent]
name = "claude"
model = "opus"
timeout = 600000
skip_permissions = true

[agent.fallback]
name = "codex"

[execution]
max_iterations = 20
iteration_delay = 2000
auto_commit = true

[guardrails]
max_consecutive_failures = 3
backpressure_commands = ["bun run typecheck", "bun run lint"]

[finalize]
auto_format = true
split_commits = true
self_review = true
create_pr = true

[tui]
theme = "tokyonight"
spinner = "braille"
show_tool_logs = true
```

## AGENTS.md

If an `AGENTS.md` file exists in the project root, its contents are included in every iteration prompt sent to the agent. Use it to provide:

- Project-specific coding conventions
- Architecture constraints
- File organization rules
- Technology preferences
- Any context that should persist across all iterations

The engine reads `AGENTS.md` from the working directory at the start of each iteration via `buildPrompt()` (`src/prompts/build.ts`).

## CLI Flags

Some commands accept flags that override config:

| Command | Flag | Overrides |
|---------|------|-----------|
| `start` | `--prd <path>` | Skips interview, uses existing PRD file |
| `spawn` | `--start` | Starts a new session in the worktree |

Most configuration is intended to live in `synth.toml` rather than CLI flags, since sessions are long-running and flags would need to be re-specified on each `resume`.

## Environment Tips

### Rate Limit Management

If you're hitting rate limits frequently:
1. Configure a fallback agent: `[agent.fallback] name = "codex"`
2. Increase iteration delay: `iteration_delay = 5000`
3. Reduce max iterations per session: `max_iterations = 10`

### Quality Gates

For TypeScript projects:
```toml
[guardrails]
backpressure_commands = ["bun run typecheck", "bun run lint"]
```

For Python projects:
```toml
[guardrails]
backpressure_commands = ["mypy .", "ruff check ."]
```

For Ruby projects:
```toml
[guardrails]
backpressure_commands = ["bundle exec rubocop", "bundle exec rspec --fail-fast"]
```

### Disabling Auto-Commit

If you prefer to review changes before committing:
```toml
[execution]
auto_commit = false
```

The engine will still track task status, but won't create git commits after each successful iteration.
