# Synth vs Ralph — Comparative Audit & Recommendations

## Context

Audit of [ralph](../ralph) (10k+ GitHub stars, by snarktank) against synth's current state. Ralph is a minimalist AI agent loop orchestrator — 114 lines of bash — that automates feature development by repeatedly spawning fresh AI instances against a shared PRD. This doc captures what's worth adopting, what to skip, and where synth already leads.

---

## Architecture Comparison

| Dimension | Ralph | Synth |
|---|---|---|
| **Core** | 114 lines of bash (`ralph.sh`) | ~15K lines TypeScript (engine, TUI, sessions, etc.) |
| **Orchestration** | Bash loop: spawn → check → sleep → repeat | Engine class: select → prompt → execute → validate → commit |
| **State** | 3 files: `prd.json`, `progress.txt`, `.last-branch` | Session directory: `metadata.json`, `tasks.json`, `progress.md`, `prd.md`, `run.json`, `interview.json`, logs/ |
| **Memory** | Append-only `progress.txt` + AGENTS.md mutations | `progress.md` + AGENTS.md (read-only) |
| **Agent support** | Amp (default) + Claude Code | Claude Code (default) + Codex |
| **Task model** | `prd.json` — flat list, priority-ordered, `passes: boolean` | `tasks.json` — dependency graph, priority + status + iterationCount + notes |
| **Quality gates** | Delegated to agent (instructions say "run typecheck/lint/test") | Explicit backpressure commands run by engine after each iteration |
| **Failure recovery** | None — bash loop just continues | Circuit breaker, rate-limit detection + exponential backoff, orphaned task reset |
| **TUI** | None (raw stdout + `tee`) | Full React/OpenTUI terminal UI with themes, keyboard nav, multiple views |
| **Distribution** | Git clone + `./ralph.sh` + Claude Code marketplace plugin | Compiled binaries + `synth update` |
| **PRD generation** | `/prd` skill (Claude Code skill format) | Interactive multi-turn interview (`synth start`) |
| **Task generation** | `/ralph` skill converts PRD markdown → prd.json | LLM-powered planner generates tasks.json from PRD |
| **Finalization** | None — user manually creates PR | Self-review → auto-format → commit splitting → PR creation |

---

## Where Synth Already Leads

These are features synth has that Ralph lacks entirely — protect and refine these:

| Feature | Why It Matters |
|---|---|
| **Backpressure / quality gates** | Ralph tells the agent "run typecheck" in the prompt — but never verifies it happened. Synth runs quality gate commands itself and fails the iteration if they don't pass. This is the difference between "please check" and "I checked." |
| **Circuit breaker** | Ralph loops until max_iterations with no failure detection. If the agent keeps failing, it burns all 10 iterations. Synth stops after 3 consecutive failures and transitions to `blocked`. |
| **Rate-limit handling** | Ralph has zero rate-limit awareness. If Claude returns a 429, ralph.sh treats it as a failed iteration and immediately retries. Synth detects rate limits, backs off exponentially, and optionally switches to a fallback agent. |
| **Dependency-aware task selection** | Ralph uses simple priority ordering — no dependency graph. Synth's `selectNextTask()` respects `dependsOn` fields, preventing ordering bugs where a UI task runs before its schema migration. |
| **Self-review pipeline** | 3-perspective AI review (developer, security, testing) of the full diff before finalization. Ralph has nothing here. |
| **Auto-format + commit splitting** | Synth detects the project's formatter, runs it, then categorizes changes into atomic commits (feat/test/docs/chore/style). Ralph commits everything in one `feat:` commit per story. |
| **PR generation** | End-to-end: PRD → tasks → code → commits → PR body → `gh pr create`. Ralph stops at commits on a branch. |
| **Session management** | Named sessions, resume from any phase, parallel sessions, session history. Ralph has no concept of sessions — just files in the repo root. |
| **Parallel execution** | Worktree-based multi-worker execution with merge engine and AI conflict resolution. Ralph is strictly serial. |
| **Full TUI** | React-based terminal UI with task sidebar, output pane, keyboard navigation, 7 themes, multiple view modes. Ralph shows raw agent stdout. |
| **Doctor command** | System diagnostics checking agent CLI, git, auth, config validity. Ralph has no preflight checks. |
| **Template system** | Phase-aware Handlebars templates with 8-level fallback chain (explicit → project phased → global phased → legacy → builtin). Ralph has 2 static markdown files (prompt.md, CLAUDE.md). |
| **Performance profiling** | `--profile` with per-phase timing breakdown. |
| **Structured task notes** | Failed iteration notes are appended to tasks and re-injected in the next attempt's prompt. Ralph's notes field exists but is never written to by the orchestrator. |
| **Acceptance criteria tracking** | Per-criterion `<ac-done>N</ac-done>` markers with real-time TUI updates. Ralph checks only the final `<promise>COMPLETE</promise>`. |
| **Run locking** | Atomic `O_CREAT|O_EXCL` lock files with PID liveness checks prevent concurrent runs on the same session. Ralph has no concurrency protection. |

---

## What Ralph Does Well (Worth Learning From)

### 1. AGENTS.md Mutation Loop

**What Ralph does:** Each iteration is explicitly instructed to update AGENTS.md files in directories it modifies. If the agent discovers that "this module uses pattern Z for all API calls" or "when modifying X, also update Y", it writes that into the nearest AGENTS.md. Future iterations (and future humans) benefit immediately.

**What synth does:** Reads AGENTS.md as project context but never writes to it. Knowledge discovered during execution stays in `progress.md` notes, which are session-scoped and not easily discoverable by future sessions or human developers.

**Why it matters:** AGENTS.md is the canonical place for project knowledge that transcends individual sessions. Progress.md is ephemeral — useful for the current session's iterations but invisible to the next `synth start`. The AGENTS.md mutation loop creates a virtuous cycle: each session makes the codebase more navigable for the next.

**Recommendation:** Add an instruction to the execution template telling the agent to update AGENTS.md with genuinely reusable patterns discovered during the task. Gate this behind a config flag (`execution.update_agents_md = true`) since some users may not want automated AGENTS.md changes. Add a section to the progress tracking instructions mirroring Ralph's format:

```
Before committing, check if any edited files have learnings worth
preserving in nearby AGENTS.md files. Only add genuinely reusable
knowledge — API patterns, gotchas, dependencies between files.
Do NOT add story-specific implementation details.
```

**Implementation scope:** Template change only — modify `DEFAULT_TEMPLATE` in `builtin.ts` to include AGENTS.md update instructions. Add `execution.update_agents_md` boolean to config with default `true`.

---

### 2. Codebase Patterns Consolidation

**What Ralph does:** Beyond per-iteration notes, Ralph instructs the agent to maintain a `## Codebase Patterns` section at the **top** of progress.txt. This section consolidates the most important reusable learnings from all iterations — not chronological entries, but distilled knowledge:

```
## Codebase Patterns
- Use `sql<number>` template for aggregations
- Always use `IF NOT EXISTS` for migrations
- Export types from actions.ts for UI components
```

The agent reads this section **first** before starting any work.

**What synth does:** `extractCodebasePatterns()` in `build.ts` already parses a `## Codebase Patterns` section from progress.md and injects it into the prompt separately from recent progress. The extraction is there, but the agent is never told to **write** to this section.

**Why it matters:** The extraction code is dead infrastructure — it'll never find patterns unless something writes them. Ralph's approach of having each iteration consolidate patterns into a top-level section creates a snowball effect: by iteration 5, the agent has a rich map of codebase conventions that prevents repeated mistakes.

**Recommendation:** Add consolidation instructions to `DEFAULT_TEMPLATE`. Synth's `extractCodebasePatterns()` already handles reading it — just need the write side. This pairs naturally with recommendation #1 (AGENTS.md mutation) as two tiers of knowledge capture: session-scoped (progress.md patterns) and project-scoped (AGENTS.md).

**Implementation scope:** Template text change only.

---

### 3. Extreme Simplicity as a Feature

**What Ralph does:** The entire orchestrator is a bash loop. No dependencies beyond `jq`. Copy it to any project, run it. The mental model is trivially simple: "spawn agent, check if done, repeat."

**Why it matters for synth:** Not that synth should become a bash script — but Ralph's popularity (10k stars) demonstrates that a simple, auditable core resonates. Synth's engine is 393 lines (good), but the total surface area is ~15K lines across 60+ files. As features are added, maintain the principle that the core loop should be understandable in one sitting.

**Recommendation:** No code change — this is an architectural principle. When adding features, keep them as separate modules that the engine calls into, not bolted into the engine itself. The engine should remain a "select → prompt → execute → validate → commit" loop that fits on one screen.

---

### 4. Dual-Tool Support Beyond CLI Agents

**What Ralph does:** Supports both Amp and Claude Code with different prompt templates (`prompt.md` vs `CLAUDE.md`). The key insight isn't the specific tools — it's that Ralph treats the prompt as the primary customization point, not code.

**What synth does:** Has a proper `AgentAdapter` interface with Claude and Codex implementations. Also has agent-specific templates (`execute/claude`, `execute/codex`). The infrastructure is better than Ralph's here.

**Why it matters:** Amp is growing fast. Kiro, Gemini CLI, Cursor Agent, and Windsurf are all emerging. Ralph's users can add a new tool by writing one prompt file. Synth requires writing a TypeScript adapter class.

**Recommendation:** The `AgentAdapter` interface is the right abstraction, but adding new agents should be easier. Consider:
1. A `detect()` method on adapters (Ralph's approach) so `synth doctor` can auto-discover available agents
2. A generic `CliAdapter` base class that handles "shell out to CLI tool with prompt on stdin/as argument" — most AI CLI tools follow this pattern
3. Document how to add a new agent in `docs/agents.md` with a concrete example

**Implementation scope:** Medium — add `GenericCliAdapter` base class, add `detect()` to interface.

---

### 5. Claude Code Marketplace Plugin Distribution

**What Ralph does:** Publishes as a Claude Code marketplace plugin (`.claude-plugin/plugin.json`). Users install with one command: `/plugin marketplace add snarktank/ralph`. Skills (`/prd`, `/ralph`) are immediately available.

**What synth does:** Distributes as a standalone binary. No integration with Claude Code's plugin/skill ecosystem.

**Why it matters:** Claude Code's skill system means synth's PRD interview and task planning could be invoked *from within Claude Code* without switching to a separate CLI. This is massive for discoverability and adoption.

**Recommendation:** Create a `.claude-plugin/` directory with synth skills:
- `/synth-prd` — Run the PRD interview flow and save to `tasks/prd-<name>.md`
- `/synth-plan` — Convert a PRD to tasks.json
- `/synth-start` — Full `synth start` equivalent

This doesn't replace the standalone CLI — it extends distribution. Users who discover synth through Claude Code marketplace can later install the full CLI for the TUI and advanced features.

**Implementation scope:** New files only — `.claude-plugin/plugin.json`, `skills/synth-prd/SKILL.md`, `skills/synth-plan/SKILL.md`. No changes to existing code.

---

### 6. Browser Verification for UI Stories

**What Ralph does:** Every UI-touching story includes "Verify in browser using dev-browser skill" as an acceptance criterion. The agent uses a `dev-browser` MCP tool to navigate to the page, interact with the UI, and take screenshots.

**What synth does:** Quality gates run CLI commands (typecheck, lint, test). No browser-level verification for frontend stories.

**Why it matters:** A component can typecheck, pass lint, and have tests, yet render incorrectly. Browser verification catches visual regressions, layout issues, and interaction bugs that no CLI check can find.

**Recommendation:** Add an optional `verification` field to tasks (already exists in the schema as `verification: {type: "command", value: string}[]`). Extend the type to support `{type: "browser", value: string}` entries. When generating tasks for UI stories, the planner should include browser verification criteria. The engine would include these in the agent prompt rather than executing them directly (since browser verification requires the agent's MCP tools).

**Implementation scope:** Small — task type extension + planner template update. The actual verification is delegated to the agent via prompt instructions, not executed by the engine.

---

### 7. Archiving / Session Rotation

**What Ralph does:** When `prd.json`'s `branchName` changes, automatically archives the previous run to `archive/YYYY-MM-DD-feature-name/`. This prevents losing work when switching features.

**What synth does:** Has a full session management system (`synth ls`, `synth show`, `synth clean`). Sessions are stored in `~/.synth/sessions/` and persist across branch switches.

**Assessment:** Synth's approach is strictly superior. Ralph archives because it has no session concept — everything lives in the repo root. Synth's external session storage solves this problem architecturally. **No action needed.**

---

### 8. Thread/Session Linking in Progress Logs

**What Ralph does (Amp-specific):** Includes the Amp thread URL in progress.txt so future iterations can use `read_thread` to reference previous work:

```
## [Date/Time] - US-003
Thread: https://ampcode.com/threads/$AMP_CURRENT_THREAD_ID
- What was implemented
```

**Why it matters:** This creates a hyperlinked audit trail. Even though each iteration is fresh, a human (or future agent) can trace back to the exact conversation that produced a change.

**Recommendation:** Include the log file path in progress.md entries so they're traceable:

```
## [Date/Time] - US-003
Log: logs/iteration-003.jsonl
- What was implemented
```

Synth already stores iteration logs — this just links them from the progress summary. Could also include the git commit SHA for direct traceability.

**Implementation scope:** Template text change only.

---

## What NOT to Adopt from Ralph

| Ralph Approach | Why Skip It |
|---|---|
| **Bash orchestrator** | Synth's TypeScript engine provides type safety, testability, and composability that bash can't match. Ralph's simplicity is elegant but limits extensibility. |
| **Flat priority ordering** | `dependsOn` is strictly superior to "just order by priority number and hope dependencies are correct." Ralph's approach silently breaks when stories have complex dependency chains. |
| **No failure detection** | Ralph loops blindly until max_iterations. This wastes tokens and time. Synth's circuit breaker is a critical safety feature. |
| **Agent-delegated quality gates** | Telling the agent "run typecheck" in the prompt is a suggestion, not enforcement. The agent can skip it, misinterpret it, or claim it passed when it didn't. Synth's engine-level backpressure commands are deterministic. |
| **prd.json in repo root** | Pollutes the working directory. Synth's `~/.synth/sessions/` external storage is cleaner. |
| **No TUI** | Raw stdout from AI agents is unusable for anything beyond watching text scroll by. The TUI is synth's primary UX advantage. |
| **No session management** | "Just copy the files" isn't session management. Synth's named sessions with resume-from-any-phase is a fundamental capability. |
| **Static prompt files** | Markdown files with no variable interpolation. Synth's Handlebars templates with phase-aware fallback chains are far more flexible. |

---

## Ralph's Design Patterns Worth Adopting

### Pattern: "Knowledge snowball"

Ralph creates a positive feedback loop where each iteration makes the next one better:

```
Iteration 1: Discovers codebase pattern → writes to progress.txt + AGENTS.md
Iteration 2: Reads patterns first → avoids mistake → discovers new pattern → writes
Iteration 3: Has 2 patterns → faster, fewer errors → discovers edge case → writes
...
Iteration N: Rich context map → completes tasks efficiently
```

Synth has half of this (progress.md reading), but not the write side (AGENTS.md mutation + pattern consolidation). Adding recommendations #1 and #2 completes the loop.

### Pattern: "One story per iteration, strictly"

Both tools enforce this, but Ralph's SKILL.md for the converter is particularly good at defining story sizing rules:

> **Rule of thumb:** If you cannot describe the change in 2-3 sentences, it is too big.

> **Right-sized:** Add a database column, add a UI component, update a server action
> **Too big:** "Build entire dashboard", "Add authentication", "Refactor the API"

Synth's planner could benefit from including these sizing heuristics in the `PLAN_TEMPLATE` to produce better-scoped tasks.

**Recommendation:** Add sizing guidance to `PLAN_TEMPLATE`:

```
- Each task must be completable in one agent iteration (~10 min of focused work)
- Right-sized: Add a database column, add a UI component, update a server action
- Too big: "Build entire dashboard", "Add authentication" — split these further
- Rule of thumb: If you cannot describe the change in 2-3 sentences, it is too big
```

---

## Suggested Priority Order

1. **Codebase patterns consolidation** — Template text change, zero code. Activates the existing dead `extractCodebasePatterns()` infrastructure. Immediate value for multi-iteration sessions.

2. **AGENTS.md mutation instructions** — Template text change + one config boolean. Creates the knowledge snowball pattern. Pairs with #1.

3. **Task sizing heuristics in planner** — Template text change. Improves task quality from the start of every session.

4. **Progress log traceability** — Template text change. Links progress entries to iteration logs and commits.

5. **Generic CLI adapter base class** — Medium code change. Unblocks adding Amp, Gemini CLI, Kiro without writing full adapters.

6. **Claude Code marketplace plugin** — New files, no code changes. Extends distribution channel.

7. **Browser verification support** — Small type extension + template update. Improves frontend story quality.

---

## Summary

Ralph and synth solve the same problem — autonomous multi-task code generation via iterative AI agent spawning — but at radically different points on the complexity spectrum. Ralph is a 114-line bash script that proves the pattern works. Synth is a production-grade tool that makes it reliable.

The main lesson from Ralph isn't any single feature — it's the **knowledge snowball pattern**. Ralph's agents actively improve the codebase's documentation (AGENTS.md) and consolidate learnings (Codebase Patterns) with every iteration, creating a positive feedback loop. Synth has the infrastructure to do this (pattern extraction, AGENTS.md injection) but doesn't close the loop by instructing agents to write back. Fixing this is mostly template text changes with outsized impact.

Everything else — marketplace distribution, browser verification, task sizing heuristics — is incremental. The core engineering (circuit breaker, backpressure, dependency graphs, parallel execution, TUI) is where synth's investment pays off, and Ralph has nothing comparable.
