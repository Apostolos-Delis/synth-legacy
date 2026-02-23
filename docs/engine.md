# Execution Engine

The engine (`src/engine/engine.ts`) is the core loop that drives task execution. It selects tasks, builds prompts, runs agents, and validates results — with circuit breakers, rate-limit handling, and quality gates to keep things on track.

## Core Loop

Each iteration follows this sequence:

```
┌─────────────────────────────────────────────────┐
│  1. Check iteration cap (>= max_iterations?)    │
│     yes -> pause                                │
├─────────────────────────────────────────────────┤
│  2. Load tasks.json from disk                   │
├─────────────────────────────────────────────────┤
│  3. allTasksDone()?                             │
│     yes -> emit "complete", state = completed   │
├─────────────────────────────────────────────────┤
│  4. selectNextTask()                            │
│     null -> state = blocked                     │
├─────────────────────────────────────────────────┤
│  5. Mark task "in_progress", save               │
├─────────────────────────────────────────────────┤
│  6. buildPrompt(task, planPaths, cwd, iteration,│
│     agentName)                                  │
├─────────────────────────────────────────────────┤
│  7. agent.execute(prompt) — stream stdout/stderr│
├─────────────────────────────────────────────────┤
│  8. Log output to logs/iteration-NNN.jsonl      │
├─────────────────────────────────────────────────┤
│  9. Rate limit detected?                        │
│     yes -> backoff, revert task to open, retry  │
├─────────────────────────────────────────────────┤
│ 10. Check for <promise>COMPLETE</promise>       │
├─────────────────────────────────────────────────┤
│ 11. Run backpressure commands                   │
├─────────────────────────────────────────────────┤
│ 12. Success? (exit 0 + backpressure pass + !timeout)
│     yes -> mark done, reset breaker, auto-commit│
│     no  -> revert to open, record in breaker    │
├─────────────────────────────────────────────────┤
│ 13. Update session with current iteration       │
├─────────────────────────────────────────────────┤
│ 14. Sleep iteration_delay ms                    │
└─────────────────────────────────────────────────┘
```

Tasks are loaded from disk at the start of every iteration, allowing manual edits to `tasks.json` between iterations.

## Engine States

| State | Meaning |
|-------|---------|
| `idle` | Engine created but not started |
| `executing` | Loop is running |
| `paused` | User-paused or iteration cap reached |
| `blocked` | Circuit breaker tripped or no eligible tasks |
| `completed` | All tasks are `done` or `skipped` |
| `failed` | Unrecoverable error |

## Engine Events

The engine emits typed events for TUI rendering and logging:

| Event | Payload | When |
|-------|---------|------|
| `iteration:start` | `{ iteration }` | Loop begins |
| `iteration:end` | `{ iteration, result }` | Loop ends |
| `task:start` | `{ task }` | Task selected |
| `task:complete` | `{ task }` | Task marked done |
| `task:failed` | `{ task, reason }` | Task failed |
| `agent:stdout` | `{ chunk }` | Agent writes to stdout |
| `agent:stderr` | `{ chunk }` | Agent writes to stderr |
| `backpressure:start` | `{ commands }` | Quality gates starting |
| `backpressure:pass` | `{ results }` | All gates passed |
| `backpressure:fail` | `{ results }` | Gate failed |
| `circuit:trip` | `{ failures }` | Breaker threshold hit |
| `rate-limit:detected` | `{ attempt, backoff }` | Rate limit detected |
| `state:change` | `{ from, to }` | Engine state transition |
| `complete` | `{}` | All tasks done |

## Circuit Breaker

The circuit breaker (`src/engine/circuit-breaker.ts`) tracks consecutive failures and trips when the threshold is reached.

```
Failure -> consecutiveFailures++ -> >= threshold? -> TRIPPED (engine blocked)
Success -> consecutiveFailures = 0  (reset)
```

**Configuration**: `guardrails.max_consecutive_failures` (default: `3`)

```typescript
class CircuitBreaker {
  constructor(threshold: number)
  recordSuccess(): void       // Resets failures to 0
  recordFailure(): boolean    // Returns true if tripped
  isTripped(): boolean
  get failures(): number
  reset(): void
}
```

When tripped, the engine transitions to `blocked` state. Use `synth resume` to reset the breaker and continue.

## Rate Limit Detection

Rate limiting is detected by scanning agent stdout + stderr for known patterns (`src/engine/rate-limit.ts`):

| Pattern | Case-Insensitive |
|---------|:---:|
| `rate.?limit` | yes |
| `429` | no |
| `too many requests` | yes |
| `quota exceeded` | yes |
| `retry.?after` | yes |
| `overloaded` | yes |
| `capacity` | yes |

### Exponential Backoff

When a rate limit is detected:

1. Increment attempt counter
2. Calculate delay: `5000 * 2^attempt` ms (capped at 120,000 ms / 2 min)
3. Revert task status to `open`
4. Sleep for the backoff delay
5. Retry the iteration

| Attempt | Delay |
|---------|-------|
| 0 | 5s |
| 1 | 10s |
| 2 | 20s |
| 3 | 40s |
| 4 | 80s |
| 5+ | 120s (cap) |

### Agent Fallback

If `agent.fallback` is configured in `synth.toml`, the engine switches to the fallback agent after a rate limit is detected. This allows seamlessly switching from Claude to Codex (or vice versa) when one provider is throttling.

## Backpressure (Quality Gates)

Backpressure commands (`src/engine/backpressure.ts`) are run after each agent iteration to validate code quality. Configured via `guardrails.backpressure_commands`:

```toml
[guardrails]
backpressure_commands = ["bun run typecheck", "bun run lint"]
```

Commands run sequentially. All must exit 0 for the iteration to count as a success. Output is truncated to 2,000 characters per command.

```typescript
interface BackpressureResult {
  passed: boolean;
  results: { command: string; exitCode: number; output: string }[];
}
```

If backpressure fails, the task is reverted to `open` with failure notes containing the command output, and the circuit breaker records a failure.

## Completion Detection

The engine detects completion through two mechanisms:

1. **Task completion signal**: The agent includes `<promise>COMPLETE</promise>` in its output, indicating it believes all tasks are done
2. **Task file check**: `allTasksDone(taskFile)` returns true when every task has status `done` or `skipped`

Both are checked each iteration. The task file check is authoritative — even without the `COMPLETE` signal, the engine will finish when all tasks are resolved.

## Session Management

Each `synth run` or `synth resume` creates a session tracked in `session.json`:

```typescript
interface SessionMetadata {
  id: string;              // "sess-<timestamp36>-<random6>"
  planId: string;
  status: SessionState;    // running | paused | completed | interrupted | failed | blocked
  startedAt: string;
  endedAt?: string;
  updatedAt: string;
  agent: string;
  currentIteration: number;
  maxIterations: number;
  cwd: string;
}
```

### Lock Files

Only one session can run per plan at a time. The lock file (`synth.lock`) is acquired atomically using `O_CREAT|O_EXCL` flags:

```typescript
interface LockFile {
  pid: number;
  sessionId: string;
  acquiredAt: string;
  hostname: string;
}
```

**Stale lock detection**: If a lock file exists but the PID is no longer running (checked via `kill(pid, 0)`), the lock is considered stale and removed automatically.

### Orphaned Task Reset

When a session starts, `resetOrphanedTasks()` resets any `in_progress` tasks back to `open`. This handles the case where a previous session crashed mid-iteration, leaving a task in a partial state.

## Auto-Commit Strategy

When `execution.auto_commit` is enabled (default: `true`), the engine commits after each successful task:

```bash
git add -u
git commit -m "feat: [Task ID] - [Task Title]"
```

The `-u` flag stages only tracked files (modified + deleted), avoiding accidentally committing untracked files. The commit message uses the task ID and title for traceability.

## Prompt Building

Each iteration prompt is assembled by `buildPrompt()` (`src/prompts/build.ts`) from four sections:

1. **ITERATION_INSTRUCTIONS** — Standard instructions telling the agent to complete one task, run quality checks, and signal completion
2. **AGENTS.md** — Project-specific agent instructions from the repo root (if present)
3. **Codebase Patterns** — Recent progress entries from `progress.md` (last 5) for context continuity
4. **Current Task** — Full task details: ID, title, priority, description, acceptance criteria, verification commands, and notes from previous failed attempts

The `notes` field is particularly important — it accumulates failure context across attempts, so the agent can learn from previous mistakes without needing conversation history.
