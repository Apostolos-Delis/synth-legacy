# Synth TUI Improvements — Ralph-TUI Audit & Recommendations

## Context

Audit of [ralph-tui](../ralph-tui) (v0.10.0) against synth's current state. Ralph-TUI is a mature AI agent loop orchestrator with 30+ TUI components, 9 agent plugins, parallel execution, and remote instance management. This doc captures what's worth adopting, what to skip, and where synth already leads.

---

## Where Synth Already Leads

These are features synth has that ralph-tui lacks entirely — protect and refine these:

| Feature | Why It Matters |
|---|---|
| **Backpressure / quality gates** | Runs lint/typecheck between iterations; catches regressions before they compound |
| **Circuit breaker** | Prevents runaway loops burning tokens on a fundamentally broken task |
| **Self-review pipeline** | 3-perspective AI review of the full diff before finalization |
| **Auto-format + commit splitting** | Clean atomic commits without human intervention |
| **PR generation** | End-to-end: PRD → tasks → code → commits → PR |
| **Acceptance criteria tracking** | Per-criterion `<ac-done>` markers with real-time TUI updates |
| **Interview-based PRD** | Structured multi-turn conversation → typed PRD schema |
| **Progress memory** | `progress.md` injected every iteration for cross-iteration continuity |
| **Performance profiling** | `--profile` with per-phase timing breakdown |
| **Clean architecture** | Engine is 393 lines vs ralph's 72KB monolith |

---

## High-Impact Features to Add

### 1. Subagent Tracing & Tool-Use Visibility

**What ralph-tui does:** Parses Claude Code's JSONL stream in real-time to build a hierarchical tree of tool calls (file reads, edits, bash commands, subagent spawns). Renders as a collapsible tree panel (`T` key) with status icons, descriptions, and durations. Four detail levels: `off` / `minimal` / `moderate` / `full`, cycled with `t`.

**Why it matters:** Right now synth shows raw agent stdout — a wall of text. Subagent tracing turns that into structured, scannable information. You can see at a glance: "it read 3 files, edited 2, ran tests, spawned a subagent for research." This is the single highest-value observability improvement.

**Implementation scope:**
- Parse JSONL events from Claude's stdout (tool_use start/end, subagent start/end)
- Build a tree data structure mapping parent→child tool calls
- New `SubagentTreePanel` component with collapsible nodes
- Detail level state in TUI, cycled with a keybinding
- Strip JSONL events from the raw output view so they don't pollute it

---

### 2. Token Usage Tracking

**What ralph-tui does:** Parses token usage fields from agent output (different formats per agent), normalizes to a `TokenUsageSummary` (input/output/cache tokens), displays per-task in the sidebar and aggregated in the dashboard.

**Why it matters:** Cost awareness. A single runaway iteration can burn $5+ in tokens. Showing cumulative spend per task and per session lets users catch prompt bloat or stuck loops early. Also useful for comparing agent/model efficiency.

**Implementation scope:**
- Parse token usage from Claude's JSONL output events
- Add `tokenUsage` field to engine events and TUI state
- Display in Header (running total) and TaskSidebar (per-task)
- Optional: cumulative cost estimate based on model pricing

---

### 3. Prompt Preview View

**What ralph-tui does:** Has a "prompt" tab in the right panel (`O` key) showing the exact prompt that was/will be sent to the agent.

**Why it matters:** When an agent does the wrong thing, the first question is always "what prompt did it get?" Currently you'd have to read `prompts/build.ts` and mentally reconstruct. A prompt preview view eliminates that guesswork entirely. Critical for debugging task failures.

**Implementation scope:**
- Store the assembled prompt string in TUI state alongside output
- New view mode or tab in OutputPane to display it
- Keybinding to toggle between output and prompt views

---

### 4. Iteration History View

**What ralph-tui does:** Dedicated view (`v` key) listing all past iterations with their task, status, duration, and token usage. Drill-down shows full output.

**Why it matters:** Synth already stores iteration logs (`logs/iteration-NNN.jsonl`) and has the `output-index.ts` loader from US-009. The data is there — it just needs a browsable view. Currently the only way to review past iterations is to read log files manually.

**Implementation scope:**
- New `IterationHistoryView` component listing iterations
- Reuse `output-index.ts` to load historical data
- Drill-down into iteration detail (full output, task info, duration)
- Keybinding to toggle view (`v`)

---

### 5. Progress Dashboard

**What ralph-tui does:** Full-screen toggleable panel (`d` key) with aggregate stats: tasks by status, iterations run, elapsed time, success/failure rate, token spend.

**Why it matters:** The current DashboardView is a task table. A progress dashboard provides a higher-level view of session health — are we making progress? What's the failure rate? How much have we spent? This is especially valuable for longer sessions (10+ tasks).

**Implementation scope:**
- New dashboard section or overlay with computed stats
- Pull from engine state: task counts by status, iteration count, elapsed time, circuit breaker state
- Add token usage aggregation once tracking is implemented
- Toggle via keybinding

---

## Medium-Impact Features to Add

### 6. Agent Plugin System

**Current state:** Synth has 2 hardcoded agents (Claude, Codex) in `agents/`. Ralph-TUI has 9 agents with a proper plugin interface (`detect()`, `preflight()`, `execute()`, `interrupt()`, sandbox requirements, rate limit config).

**Recommendation:** Formalize the existing `AgentAdapter` interface and add a plugin registry pattern. This makes adding Gemini CLI, Kiro, Cursor, etc. a single-file addition without touching core code. The interface is already close — just needs discoverability and a `detect()` method for auto-selection.

---

### 7. Settings / Config View in TUI

**What ralph-tui does:** Interactive config editor opened with `,` key. Also a read-only config viewer with `C`.

**Recommendation:** Start with read-only config display (show the resolved `synth.toml` + defaults). Interactive editing is nice-to-have but risky (TOML serialization edge cases). Even just seeing "which model am I using? which agent? what are my quality gate commands?" without quitting is valuable.

---

### 8. Doctor Command

**What ralph-tui does:** `ralph-tui doctor` checks agent availability, config validity, environment health.

**Recommendation:** `synth doctor` that verifies: agent CLI installed and accessible, git repo is clean enough to start, `synth.toml` is valid, `~/.synth/` directory exists, quality gate commands are executable. Saves debugging time when something doesn't work.

---

### 9. Parallel Task Execution

**What ralph-tui does:** Full git-worktree-based parallel execution — dependency graph analysis groups independent tasks into waves, N workers run in isolated worktrees, worker branches merge sequentially back to a session branch, with AI-powered conflict resolution for merge failures. 7 dedicated files: `task-graph.ts`, `worker.ts`, `worktree-manager.ts`, `merge-engine.ts`, `conflict-resolver.ts`, `ai-resolver.ts`, `session.ts`.

**Why it matters:** Synth already has `synth spawn` for running in a worktree, but no coordination layer. For plans with 10+ tasks where many are independent, serial execution leaves huge time savings on the table. Parallel execution with proper dependency awareness can cut session time dramatically.

**Implementation scope:**
- **Task graph analysis**: Analyze `dependsOn` fields to group independent tasks into parallel waves (tasks with no unresolved dependencies that don't depend on each other)
- **Worker management**: Spawn N engine instances in isolated git worktrees, each working on a different task from the current wave
- **Worktree lifecycle**: Create worktrees from session branch, clean up on completion/failure
- **Merge engine**: Sequential merge of completed worker branches back to the session branch, ordered by task priority
- **AI conflict resolution**: When merge conflicts occur, send the conflict hunks + file context to the agent for resolution. Fall back to flagging for human review if AI resolution fails or confidence is low
- **TUI integration**: Workers panel showing per-worker status (task, progress, agent output), merge queue panel, conflict resolution view
- **CLI flag**: `--parallel [N]` to set worker count, default to serial execution
- **Session branch management**: Create a `synth-session/{session-id}` branch to isolate parallel work from the user's working branch

**Design considerations (learn from ralph-tui's mistakes):**
- Keep the parallel coordinator as a separate module, not bolted into the existing engine — the engine should remain a single-task executor
- AI conflict resolution should have a confidence threshold — if the merge is non-trivial (>N conflict hunks or touches >M files), escalate to human review instead of silently resolving
- Backpressure / quality gates should still run per-worker after each task, not just at merge time

---

### 10. Diff Preview Before Auto-Commit

**Neither project has this.** Both auto-commit on task success without review.

**Recommendation:** After an iteration succeeds and before auto-committing, show a summarized git diff in the TUI. Let the user approve (commit), reject (revert), or edit. This catches agent mistakes before they become permanent. Could be opt-in via config flag.

---

## What NOT to Build

Lessons from ralph-tui's over-engineering:

| Feature | Why Skip It |
|---|---|
| **Remote WebSocket management** | 100KB+ of code (server + client + auth + audit). SSH + tmux covers 90% of use cases. `synth spawn` in a worktree is already the right primitive. |
| **~~AI-powered merge conflict resolution~~** | ~~Sounds impressive, risks silent corruption. Flag conflicts for human review instead.~~ *Moved to planned features — will implement with confidence thresholds and human fallback.* |
| **Sound effects** | Zero productivity value. Desktop notifications are sufficient. |
| **Documentation website** | README is fine until there are external users at scale. |
| **Bundled slash commands** | Keep as separate packages if needed. Don't couple skill distribution to the core tool. |
| **Multi-tracker plugin system** | Synth's `tasks.json` approach is simpler and sufficient. Don't add Beads/external tracker integrations unless there's real demand. |

---

## Ralph-TUI Architecture Anti-Patterns to Avoid

1. **God components**: `RunApp.tsx` at 142KB handles all keyboard routing, state, views, and events in one file. Synth's `App.tsx` is 229 lines — keep it that way by extracting new features into focused components.

2. **Engine monolith**: Ralph's `engine/index.ts` is 72KB. Synth's is 393 lines with concerns split into `circuit-breaker.ts`, `rate-limit.ts`, `backpressure.ts`, etc. Continue this pattern.

3. **No state management abstraction**: Ralph passes everything via props from one massive component. If synth's TUI state grows significantly, consider a reducer pattern or event bus to decouple state updates from rendering.

---

## Suggested Priority Order

1. **Subagent tracing** — highest observability impact, makes the TUI genuinely useful during execution
2. **Token usage tracking** — cost awareness, easy to implement alongside tracing (same JSONL stream)
3. **Prompt preview** — critical debugging tool, small implementation surface
4. **Iteration history** — data already exists (US-009), just needs a view
5. **Parallel task execution** — biggest throughput multiplier, unlocks the full value of dependency-aware task graphs
6. **Progress dashboard** — polish, builds on token tracking
7. **Agent plugin system** — architectural improvement, unlocks multi-agent support
8. **Diff preview** — safety net, opt-in
9. **Doctor command** — quality of life
10. **Config view** — nice-to-have
