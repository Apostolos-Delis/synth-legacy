# Architecture

Synth is a CLI tool that orchestrates AI coding agents through a structured plan-execute-review lifecycle. This document covers the system design, data flow, and key architectural decisions.

## High-Level Architecture

```
                         +------------------+
                         |    User (CLI)    |
                         +--------+---------+
                                  |
                    +-------------+-------------+
                    |             |              |
               synth plan    synth run     synth finalize
                    |             |              |
                    v             v              v
             +-----------+  +---------+  +-----------+
             | Interview |  | Engine  |  | Finalize  |
             +-----------+  +---------+  +-----------+
                    |             |              |
                    v             v              v
             +------------------------------------------+
             |        Plan Storage (~/.synth/)           |
             |  metadata | prd | tasks | session | logs |
             +------------------------------------------+
                                  |
                                  v
                         +------------------+
                         |  Agent Adapters  |
                         |  Claude | Codex  |
                         +------------------+
                                  |
                                  v
                         +------------------+
                         |   Subprocess     |
                         |  (claude / codex |
                         |   CLI binary)    |
                         +------------------+
```

## State Machine

Plans progress through a defined set of states:

```
interviewing --> planning --> executing <--> paused
                                |    \         ^
                                |     \        |
                                v      v       |
                            completed  blocked-+
                                |        |
                                v        v
                            finalized  failed
```

| State | Description |
|-------|-------------|
| `interviewing` | PRD interview in progress |
| `planning` | Task generation from PRD |
| `executing` | Engine loop running |
| `paused` | User-paused or iteration cap reached |
| `blocked` | Circuit breaker tripped or no eligible tasks |
| `completed` | All tasks done |
| `finalized` | PR created successfully |
| `failed` | Unrecoverable error |

The engine itself tracks a separate runtime state: `idle`, `executing`, `paused`, `blocked`, `completed`, `failed`.

## On-Disk Layout

Synth stores all plan data outside the project repository to avoid polluting the working tree.

### Global storage

```
~/.synth/plans/
  <repo-key>/                      # e.g. "owner/repo-name"
    <plan-id>/                     # e.g. "bold-falcon-42"
      metadata.json                # PlanMetadata — status, timestamps, progress
      prd.md                       # Generated PRD in markdown
      tasks.json                   # TaskFile — task list with status
      progress.md                  # Iteration log (appended per success)
      session.json                 # SessionMetadata — current session state
      synth.lock                   # Atomic lock file (PID, hostname)
      logs/
        iteration-001.jsonl        # Raw agent output per iteration
        iteration-002.jsonl
        ...
```

### Project root

```
<project>/
  synth.toml                       # Project configuration
  AGENTS.md                        # Optional — included in agent prompts
```

The **repo key** is derived from the git remote origin URL (normalized: strip `.git` suffix, protocol, and host; lowercase; last two path segments joined by `/`). For repos without a remote, it falls back to the directory name.

## Data Flow

### 1. Interview Phase (`synth plan`)

```
User input --> Interviewer --> Agent (multi-turn) --> GeneratedPrd
                                                        |
                                                        v
                                                    prdToMarkdown()
                                                        |
                                                        v
                                                      prd.md
                                                        |
                                                        v
                                                  generateTasks()
                                                        |
                                                        v
                                                    tasks.json
```

The interviewer maintains a sliding window of the last 16 messages (8 turns) to keep context manageable. When the agent emits a JSON-fenced PRD, it's extracted, validated, converted to markdown, and fed to the task planner.

### 2. Execution Phase (`synth run`)

```
for each iteration:
  tasks.json --> selectNextTask() --> task
                                       |
                                       v
                                 buildPrompt()
                  (AGENTS.md + patterns + progress + task)
                                       |
                                       v
                                 agent.execute()
                                       |
                            +----------+----------+
                            |                     |
                     rate limited?           completed?
                     backoff + retry     check backpressure
                                               |
                                        +------+------+
                                        |             |
                                     passed        failed
                                        |             |
                                  mark done      record failure
                                  auto-commit    circuit breaker
                                  progress.md         |
                                        |        tripped?
                                        |          -> blocked
                                        v
                                  next iteration
```

### 3. Finalize Phase (`synth finalize`)

```
git diff --> self-review (3 perspectives) --> findings
                                                |
                                          critical? -> BLOCK
                                                |
                                                v
                                        auto-format (detected)
                                                |
                                                v
                                        split commits (by category)
                                                |
                                                v
                                        generate PR body
                                                |
                                                v
                                        gh pr create
```

## Module Dependency Graph

```
cli.tsx
  |
  +-- config/loader ---- config/defaults + config/types
  |
  +-- plans/registry --- plans/id + plans/types + utils/fs
  |
  +-- interview/interviewer --- interview/prompts + interview/types
  |                              + agents/*
  |
  +-- tasks/planner --- tasks/types + agents/*
  |
  +-- engine/engine --- engine/circuit-breaker
  |                  +- engine/rate-limit
  |                  +- engine/backpressure
  |                  +- tasks/store + tasks/selector
  |                  +- prompts/build
  |                  +- session/session
  |                  +- agents/registry
  |
  +-- finalize/finalize --- finalize/review
  |                      +- finalize/formatter
  |                      +- finalize/splitter
  |                      +- finalize/pr
  |
  +-- tui/App --- tui/ExecutionView
              +- tui/DashboardView
              +- tui/InterviewView
              +- tui/components/*
```

## Key Design Decisions

### Files over context windows

Each agent iteration starts with a fresh context. The engine reads `tasks.json` from disk at the start of every loop, builds a prompt that includes only the relevant task and recent progress, and sends it as a single shot. This avoids context window bloat, makes the system debuggable (every file is inspectable), and allows manual intervention between iterations.

### Fresh agent per iteration

Rather than maintaining a long-running agent conversation, Synth spawns a new subprocess for each task. This ensures:
- No accumulated context drift
- Clean process state (no leaked file handles, env vars, etc.)
- Predictable resource usage
- Easy timeout and interrupt handling

### Global plan storage

Plans live in `~/.synth/plans/` rather than in the project directory because:
- No `.gitignore` additions needed
- Multiple plans can target the same repo
- Session state and logs don't clutter the working tree
- Plans survive branch switches and `git clean`

### Dependency-aware task selection

Tasks declare `dependsOn` relationships. The selector filters to candidates whose dependencies are all satisfied (`done` or `skipped`), then sorts by priority. This prevents execution ordering bugs without requiring the user to manually sequence tasks.

### Atomic file locking

Session locking uses `O_CREAT|O_EXCL` (exclusive create) for race-free acquisition. Stale locks from crashed processes are detected via PID liveness checks using signal zero (`kill(pid, 0)`).
