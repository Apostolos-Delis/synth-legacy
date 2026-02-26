# Synth

**AI Agent Loop Orchestrator — from idea to PR in two commands.**

## What is Synth?

Synth orchestrates AI coding agents (Claude Code, OpenAI Codex) to execute multi-task development plans autonomously. It drives an interview to produce a PRD, breaks it into dependency-ordered tasks, then loops an agent through each task with built-in guardrails — circuit breakers, rate-limit backoff, and quality-gate validation. Memory lives in files on disk, so every iteration starts with a fresh context window and a clear objective.

## Installation

### Install script (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Apostolos-Delis/synth/main/install.sh | bash
```

Downloads the correct binary for your platform to `~/.local/bin/synth`.

### From source

```bash
git clone https://github.com/Apostolos-Delis/synth.git
cd synth
bun install
bun link
```

## Quickstart

```bash
# Create synth.toml in your project
synth init

# Start an interactive interview, generate tasks, execute, and create a PR
synth start

# If interrupted, pick up where you left off
synth resume
```

## CLI Reference

| Command | Usage | Description |
|---------|-------|-------------|
| `start` | `synth start [--prd <path>]` | Interview → generate tasks → execute → PR |
| `resume` | `synth resume [<session-id>]` | Resume a paused or interrupted session |
| `ls` | `synth ls [--all]` | List sessions for the current repo (hides completed by default) |
| `session` | `synth session <session-id>` | Show detailed session info and task list |
| `logs` | `synth logs <session-id>` | Show session log output |
| `status` | `synth status [<session-id>]` | Show progress bar and session state |
| `spawn` | `synth spawn [<session-id>] [--start]` | Run synth in a git worktree (background) |
| `ps` | `synth ps` | List currently running session instances |
| `clean` | `synth clean` | Remove abandoned sessions |
| `init` | `synth init` | Create `synth.toml` from template |
| `themes` | `synth themes` | List available themes and spinners |
| `config` | `synth config` | Dump resolved configuration as JSON |
| `update` | `synth update` | Update synth to the latest release |
| `version` | `synth --version` | Show installed version |
| `help` | `synth help` | Show usage and command list |

## Configuration

Create `synth.toml` in your project root (or run `synth init`):

```toml
[project]
name = "my-app"
branch = "feature/my-feature"

[agent]
name = "claude"             # "claude" | "codex"
model = "opus"
timeout = 600000            # 10 min per iteration

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
theme = "tokyonight"              # See synth themes for options
spinner = "braille"
```

See [docs/configuration.md](docs/configuration.md) for a full field-by-field reference.

## Architecture Overview

```
User
  |
  v
CLI (cli.tsx) ---- command routing
  |
  |--- start        -> Interviewer -> Task Planner -> Engine loop -> Review -> PR
  |--- resume       -> Pick up any phase where it left off
  |
  v
Engine (engine.ts)
  |
  +-- Task Selector ---- dependency-aware priority queue
  +-- Prompt Builder --- AGENTS.md + codebase patterns + task
  +-- Agent Adapter ---- subprocess execution (Claude / Codex)
  +-- Circuit Breaker -- consecutive failure guard
  +-- Rate Limiter ----- detection + exponential backoff
  +-- Backpressure ----- quality gate commands
  +-- Run Manager ------ atomic locking + state tracking
  |
  v
Session Storage (~/.synth/sessions/<repo>/<session-id>/)
  +-- metadata.json    +-- tasks.json
  +-- prd.md           +-- progress.md
  +-- run.json         +-- synth.lock
  +-- interview.json   +-- logs/
```

See [docs/architecture.md](docs/architecture.md) for state machines, data flow diagrams, and design decisions.

## Project Structure

```
src/
  cli.tsx                   # CLI entry point, command routing
  agents/                   # Agent adapter system
    types.ts                #   AgentAdapter interface
    claude.ts               #   Claude Code CLI adapter
    codex.ts                #   OpenAI Codex CLI adapter
    registry.ts             #   Agent factory
  config/                   # Configuration
    types.ts                #   SynthConfig interface
    defaults.ts             #   Default values
    loader.ts               #   TOML loader + deep merge
  conversation/             # Shared conversation engine
    engine.ts               #   ConversationEngine class
    types.ts                #   ConversationMessage
  engine/                   # Execution engine
    engine.ts               #   Core loop (select -> prompt -> execute -> validate)
    circuit-breaker.ts      #   Consecutive failure guard
    rate-limit.ts           #   Rate limit detection + backoff
    backpressure.ts         #   Quality gate runner
  finalize/                 # Finalize pipeline
    finalize.ts             #   Pipeline orchestrator
    orchestrator.ts         #   Conversation-based finalize flow
    review.ts               #   AI self-review (3 perspectives)
    formatter.ts            #   Auto-formatter detection
    splitter.ts             #   Commit categorization
    pr.ts                   #   PR body generation + gh integration
  interview/                # PRD interview
    interviewer.ts          #   Multi-turn interview loop (uses ConversationEngine)
    prompts.ts              #   System prompt
    types.ts                #   InterviewMessage, GeneratedPrd
  sessions/                 # Session management
    registry.ts             #   Session CRUD + storage + migration
    id.ts                   #   Human-readable ID generator
    slug.ts                 #   Session slug + task prefix derivation
    types.ts                #   SessionMetadata, SessionPaths
  prompts/                  # Prompt assembly
    build.ts                #   buildPrompt() — iteration prompt
    instructions.ts         #   ITERATION_INSTRUCTIONS constant
  run/                      # Execution run lifecycle
    run.ts                  #   Create, update, end + atomic locking
    types.ts                #   RunMetadata, RunState, LockFile
  tasks/                    # Task management
    types.ts                #   Task, TaskFile interfaces
    store.ts                #   Task persistence + helpers
    selector.ts             #   Dependency-aware task selection
    planner.ts              #   LLM-powered task generation
  tui/                      # Terminal UI
    App.tsx                 #   Root app + keyboard navigation
    DashboardView.tsx       #   Task table view
    ExecutionView.tsx       #   Split-pane execution view
    InterviewApp.tsx        #   Chat-style interview app
    FinalizeApp.tsx         #   Finalize conversation app
    theme.ts                #   ThemeColors interface + runtime colors
    spinners.ts             #   Spinner presets (dots, braille, etc.)
    themes/                 #   Built-in theme definitions
      registry.ts           #     Theme registry + custom discovery
      resolve.ts            #     Theme/spinner resolution logic
    components/             #   Reusable UI components
  utils/                    # Shared utilities
    fs.ts                   #   File I/O wrappers
    process.ts              #   Subprocess spawning
    git.ts                  #   Git operations
    format.ts               #   Formatting helpers
  __tests__/                # Test suite
```

## Development

```bash
# Type checking
bun run typecheck

# Run tests
bun run test

# Lint
bun run lint

# Build
bun run build
```

## Documentation

- [Architecture](docs/architecture.md) — System design, state machines, data flow
- [Engine](docs/engine.md) — Core execution loop and guardrails
- [Agents](docs/agents.md) — Agent adapter system and extension guide
- [Tasks](docs/tasks.md) — Task lifecycle, dependencies, and generation
- [Interview](docs/interview.md) — PRD interview system
- [Finalize](docs/finalize.md) — Review, formatting, commit splitting, and PR creation
- [TUI](docs/tui.md) — Terminal UI architecture, components, and [themes](docs/tui.md#themes)
- [Configuration](docs/configuration.md) — Full configuration reference

## License

TBD
