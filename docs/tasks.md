# Task Management

Tasks are the unit of work in Synth. Each task represents a focused, independently completable piece of implementation. The task system handles persistence, dependency resolution, status tracking, and LLM-powered generation.

## Task Interface

Defined in `src/tasks/types.ts`:

```typescript
interface Task {
  id: string;                      // e.g. "US-001"
  title: string;
  description: string;
  acceptanceCriteria: string[];
  verification?: { type: "command" | "regex"; value: string }[];
  priority: 1 | 2 | 3 | 4 | 5;   // 1 = highest
  status: "open" | "in_progress" | "done" | "failed" | "skipped";
  dependsOn?: string[];            // Task IDs this task requires
  notes?: string;                  // Accumulated failure context
  iterationCount: number;          // Number of execution attempts
}
```

### Field Details

| Field | Description |
|-------|-------------|
| `id` | Unique identifier following `US-NNN` format (e.g. `US-001`, `US-002`) |
| `title` | Short imperative description of the task |
| `description` | Detailed implementation instructions for the agent |
| `acceptanceCriteria` | List of conditions that must be true for the task to be considered done |
| `verification` | Optional automated checks — `command` runs a shell command (exit 0 = pass), `regex` matches against output |
| `priority` | 1 (critical) through 5 (nice-to-have) — determines execution order |
| `status` | Current lifecycle state |
| `dependsOn` | IDs of tasks that must be `done` or `skipped` before this task can start |
| `notes` | Failure context appended by the engine across retry attempts |
| `iterationCount` | Incremented each time the task enters `in_progress` |

## TaskFile

Tasks are stored as a `TaskFile`:

```typescript
interface TaskFile {
  project: string;
  branchName: string;
  description: string;
  tasks: Task[];
}
```

Persisted at `~/.synth/plans/<repo>/<plan-id>/tasks.json`.

## Task Lifecycle

```
open ──────────> in_progress ──────────> done
  ^                  |
  |                  v
  +──────────── failed/open
                     |
                     v
                  skipped (manual)
```

| Status | Meaning |
|--------|---------|
| `open` | Ready to be picked up |
| `in_progress` | Currently being executed by an agent |
| `done` | Completed successfully (backpressure passed) |
| `failed` | Explicitly marked as failed (not used by engine — engine reverts to `open`) |
| `skipped` | Manually skipped by user |

The engine never sets `failed` permanently — on failure, tasks revert to `open` with notes appended. This allows automatic retry with accumulated context. The circuit breaker handles the case of repeated failures.

### Iteration Count

`iterationCount` increments each time a task enters `in_progress`. This tracks how many attempts have been made, visible in the dashboard view and useful for identifying problematic tasks.

### Notes Feedback Loop

When a task fails, the engine appends failure context to the `notes` field:

```
Previous attempt failed — exit code: 1
Backpressure failed: bun run typecheck
Output: src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'
```

On the next attempt, these notes are included in the agent prompt via `buildPrompt()`, giving the agent context about what went wrong without needing conversation history.

## Task Store

`src/tasks/store.ts` provides CRUD operations:

| Function | Description |
|----------|-------------|
| `loadTasks(path)` | Read and parse `tasks.json` |
| `saveTasks(path, taskFile)` | Write `tasks.json` |
| `updateTaskStatus(taskFile, taskId, status, notes?)` | Immutable update — returns new TaskFile. Appends notes, increments `iterationCount` on `in_progress` |
| `getTaskById(taskFile, taskId)` | Lookup by ID |
| `allTasksDone(taskFile)` | True when all tasks are `done` or `skipped` |
| `resetOrphanedTasks(taskFile)` | Reset `in_progress` tasks to `open` (crash recovery) |
| `getProgress(taskFile)` | Returns `{ total, done, failed, open, inProgress }` |

All updates are immutable — `updateTaskStatus` returns a new `TaskFile` rather than mutating in place.

## Dependency Resolution

`src/tasks/selector.ts` implements dependency-aware task selection:

```typescript
function selectNextTask(taskFile: TaskFile): Task | null
```

Algorithm:

1. Build a set of completed task IDs (status `done` or `skipped`)
2. Filter to candidates: status is `open` AND every `dependsOn` ID is in the completed set
3. Sort candidates by `priority` ascending (1 first), then by `id` lexicographically for deterministic ordering
4. Return the first candidate, or `null` if no eligible tasks

When `null` is returned, the engine transitions to `blocked` — either all remaining tasks have unsatisfied dependencies, or there are no tasks left (which is handled separately by `allTasksDone`).

### Example

```
US-001 (priority: 1, depends: [])        -> eligible
US-002 (priority: 2, depends: [US-001])  -> blocked by US-001
US-003 (priority: 1, depends: [])        -> eligible
US-004 (priority: 3, depends: [US-002])  -> blocked by US-002
```

Selection order: `US-001` (P1, lower ID), then `US-003` (P1, higher ID), then `US-002` (P2, US-001 now done), then `US-004` (P3, US-002 now done).

## Task Generation

`src/tasks/planner.ts` generates tasks from a PRD using an AI agent:

```typescript
async function generateTasks(
  agent: AgentAdapter,
  prd: string,
  projectName: string,
  branchName: string,
  cwd: string
): Promise<TaskFile>
```

### Planner Prompt

The planner sends a structured prompt requesting a JSON `TaskFile` with rules:
- IDs follow `US-001`, `US-002` format
- Priority 1-5
- `dependsOn` references other task IDs
- Verification commands for automated checking
- Each task should be completable in ~10 minutes

### JSON Extraction

The planner handles varied agent output formats:

1. Try fenced JSON blocks (`` ```json ... ``` ``)
2. Try all JSON objects in output (last to first, preferring the most complete)
3. Fall back to greedy regex matching

### Defaults

After extraction, the planner applies defaults to every task:
- `status: "open"`
- `iterationCount: 0`
- `notes: ""`

## Orphaned Task Reset

When a session starts, `resetOrphanedTasks()` finds any tasks with status `in_progress` and resets them to `open`. This handles the case where a previous session was killed mid-iteration (Ctrl+C, crash, system shutdown), leaving a task in a state that no agent is actually working on.
