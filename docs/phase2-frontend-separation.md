# Phase 2: Frontend / Backend Separation — Planning Pipeline

Phase 1 separated the **execution** path: the engine loop, task selection, and agent orchestration are now backend concerns that communicate with the TUI through an event-driven adapter. Phase 2 applies the same pattern to the **planning** path — the interview, PRD review, task generation, and task review phases that currently live inline in `src/commands/start.tsx` and `src/commands/resume.tsx`.

This document describes the remaining work, the target architecture, and how the patterns established in Phase 1 extend to planning-phase decision points.

## Current State

### Where planning logic lives today

The planning phases are implemented as Promise-wrapped React renders inside command functions. Each phase blocks the command until the user completes it:

```
start.tsx (cmdStart / cmdPlan)
  |
  +-- Phase 1: Interview         [lines 736-787]
  |     render(<InterviewApp>)
  |     await Promise<boolean>
  |
  +-- Phase 2: PRD Review         [lines 844-885]
  |     render(<PrdReviewView>)
  |     await Promise<boolean>
  |
  +-- Phase 3: Task Generation    [lines 899-925]
  |     generateTasks(agent, prd, ...)
  |     stream progress to TUI
  |
  +-- Phase 4: Task Review        [lines 935-954]
        render(<ReviewView>)
        await Promise<boolean>
```

`resume.tsx` duplicates parts of this flow (PRD review at line 466, task review) depending on which session state it resumes from.

### Problems with the current design

1. **Tight coupling** — Planning logic is interleaved with TUI rendering, Ink lifecycle, and CLI argument handling in 1000+ line command files.
2. **Duplication** — `start.tsx` and `resume.tsx` both implement PRD review and task review with nearly identical Promise-modal patterns.
3. **No adapter boundary** — There is no equivalent of `AgentAdapter` for planning decisions. The TUI components are called directly, making it impossible to swap in a non-interactive frontend (e.g., `--auto` mode, HTTP API, or test harness).
4. **Callback inconsistency** — Interview uses streaming callbacks (`onChunk`, `onTool`, `onReset`), PRD review uses `onApprove`/`onQuit`, and task review uses `onConfirm`/`onDecline`. There is no shared protocol.

### Current architecture (planning path)

```
┌─────────────────────────────────────────────────────────┐
│                     CLI Commands                         │
│                                                         │
│  start.tsx ──┬── Interview ──── InterviewApp (React)    │
│              ├── PRD Review ─── PrdReviewView (React)   │
│              ├── Task Gen ───── planner.ts               │
│              └── Task Review ── ReviewView (React)       │
│                                                         │
│  resume.tsx ─┬── PRD Review ─── PrdReviewView (React)   │
│              └── Task Review ── ReviewView (React)       │
│                                                         │
│  (Everything is one monolithic call chain)               │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │   Session Storage   │
              │   interview.json    │
              │   prd.md            │
              │   tasks.json        │
              └─────────────────────┘
```

## Target End-State

### Architecture: CLI → Pipeline(s) → Adapter(s)

The target architecture mirrors the execution path: CLI commands become thin entry points that instantiate a pipeline and an adapter, then step back.

```
┌──────────────────────────────────────────────────────────────────┐
│  CLI (thin entry points)                                         │
│                                                                  │
│  start.tsx ──→ PlanningPipeline ──→ ExecutionPipeline            │
│  resume.tsx ─→ PlanningPipeline and/or ExecutionPipeline         │
│  run.tsx ────→ PlanningPipeline ──→ ExecutionPipeline (--auto)   │
└──────────┬───────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│  PlanningPipeline                                                │
│                                                                  │
│  Orchestrates phases in order. Each phase calls                  │
│  requestAction() on the adapter and awaits submitAction().       │
│                                                                  │
│  ┌─────────────┐   ┌────────────┐   ┌──────────┐   ┌─────────┐ │
│  │  Interview   │──→│ PRD Review │──→│ Task Gen │──→│Task Rev.│ │
│  └─────────────┘   └────────────┘   └──────────┘   └─────────┘ │
│                                                                  │
│  State transitions: interviewing → planning → ready              │
└──────────┬───────────────────────────────────────────────────────┘
           │ requestAction / submitAction
           ▼
┌──────────────────────────────────────────────────────────────────┐
│  PlanningAdapter (interface)                                     │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐ │
│  │  TuiPlanningAdpt│  │ AutoPlanningAdpt│  │ TestPlanningAdpt │ │
│  │  (Ink/React)    │  │ (--auto mode)   │  │ (unit tests)     │ │
│  └─────────────────┘  └─────────────────┘  └──────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│  Session Storage (unchanged)                                     │
│  interview.json │ prd.md │ tasks.json │ metadata.json            │
└──────────────────────────────────────────────────────────────────┘
```

### Design principles (carried from Phase 1)

- **Pipeline owns the workflow** — Phase ordering, state persistence, and error handling live in the pipeline, not in CLI commands or TUI components.
- **Adapter owns the interaction** — How a decision is presented (modal, auto-approve, HTTP endpoint) is the adapter's concern.
- **requestAction/submitAction is the contract** — The pipeline never renders UI directly. It emits actions and waits for responses.
- **Session storage is the source of truth** — Pipelines read/write session files. This enables resume from any point.

## Detailed Design

### PlanningPipeline

A new module at `src/planning/pipeline.ts` that orchestrates the four planning phases sequentially.

```typescript
interface PlanningPipeline {
  run(context: PlanningContext): Promise<PlanningResult>;
}

interface PlanningContext {
  cwd: string;
  sessionId: string;
  paths: SessionPaths;
  agent: AgentAdapter;
  adapter: PlanningAdapter;
  resumeFrom?: PlanningPhase;  // skip completed phases on resume
}

type PlanningPhase = "interview" | "prd-review" | "task-generation" | "task-review";

interface PlanningResult {
  tasks: TaskFile;
  prdPath: string;
  aborted: boolean;
  abortedAt?: PlanningPhase;
}
```

The pipeline:
1. Checks session state to determine which phase to start from.
2. Runs each phase in sequence, calling `adapter.requestAction()` for decisions.
3. Persists state to disk after each phase completes (interview.json, prd.md, tasks.json).
4. Returns a `PlanningResult` that the CLI command uses to decide whether to proceed to execution.

### requestAction / submitAction Protocol

This is the core contract between the pipeline and the adapter. The pipeline describes what decision it needs; the adapter collects the answer however it wants.

```typescript
// The pipeline emits these to request a decision from the user
type PlanningAction =
  | { type: "interview"; interviewer: Interviewer; history: InterviewMessage[] }
  | { type: "approve-prd"; prdMarkdown: string; agent: AgentAdapter }
  | { type: "review-tasks"; tasks: Task[] }
  | { type: "progress"; phase: PlanningPhase; message: string };

// The adapter returns these after the user decides
type PlanningResponse =
  | { type: "interview-complete"; prdMarkdown: string }
  | { type: "interview-aborted" }
  | { type: "prd-approved"; finalizedPrd: string }
  | { type: "prd-rejected" }                          // user quit
  | { type: "tasks-confirmed" }
  | { type: "tasks-declined" };

interface PlanningAdapter {
  requestAction(action: PlanningAction): Promise<PlanningResponse>;
}
```

#### How existing decision points map

| Current code | Action type | Response type |
|---|---|---|
| `InterviewApp` `onComplete`/`onQuit` | `interview` | `interview-complete` / `interview-aborted` |
| `PrdReviewView` `onApprove`/`onQuit` | `approve-prd` | `prd-approved` / `prd-rejected` |
| `ReviewView` `onConfirm`/`onDecline` | `review-tasks` | `tasks-confirmed` / `tasks-declined` |

#### Streaming during interview and PRD review

The `interview` and `approve-prd` actions include the `Interviewer` / `AgentAdapter` instance so the adapter can drive the multi-turn conversation and stream chunks directly to the TUI. The pipeline does not need to know about streaming — it hands over the agent and waits for the final decision.

### Extracting start.tsx

`cmdStart` becomes a thin orchestrator:

```
cmdStart(args):
  adapter = tuiEnabled ? new TuiPlanningAdapter(root) : new CliPlanningAdapter()
  pipeline = new PlanningPipeline()

  result = await pipeline.run({ cwd, sessionId, paths, agent, adapter })
  if result.aborted: return

  // Hand off to execution (Phase 1 pattern)
  engine = new ExecutionPipeline(...)
  await engine.run(result.tasks)
```

What stays in `start.tsx`: CLI argument parsing, session creation, adapter selection.
What moves out: all planning phase logic, state transitions, Promise-modal patterns.

### Extracting resume.tsx

`cmdResume` currently re-implements planning phases when resuming from `interviewing` or `planning` state. With the pipeline:

```
cmdResume(args):
  session = loadSession(sessionId)
  adapter = tuiEnabled ? new TuiPlanningAdapter(root) : new CliPlanningAdapter()

  if session.status in ["interviewing", "planning"]:
    pipeline = new PlanningPipeline()
    result = await pipeline.run({
      ..., adapter,
      resumeFrom: mapStatusToPhase(session.status)
    })
    if result.aborted: return

  // Proceed to execution
  engine = new ExecutionPipeline(...)
  await engine.run(loadTasks(session))
```

The key insight: `resume.tsx` doesn't need its own planning code. It creates a `PlanningPipeline` with a `resumeFrom` hint, and the pipeline skips phases that are already complete (checking session storage).

### TuiPlanningAdapter

The TUI adapter translates `requestAction` calls into Ink component renders, exactly as the code does today — but behind the adapter interface:

```typescript
class TuiPlanningAdapter implements PlanningAdapter {
  constructor(private root: InkRoot) {}

  async requestAction(action: PlanningAction): Promise<PlanningResponse> {
    switch (action.type) {
      case "interview":
        return new Promise((resolve) => {
          this.root.render(
            <InterviewApp
              onComplete={() => resolve({ type: "interview-complete", prdMarkdown: ... }))
              onQuit={() => resolve({ type: "interview-aborted" }))
              ...
            />
          );
        });
      case "approve-prd":
        return new Promise((resolve) => {
          this.root.render(
            <PrdReviewView
              prdMarkdown={action.prdMarkdown}
              onApprove={(prd) => resolve({ type: "prd-approved", finalizedPrd: prd }))
              onQuit={() => resolve({ type: "prd-rejected" }))
            />
          );
        });
      case "review-tasks":
        return new Promise((resolve) => {
          this.root.render(
            <ReviewView
              tasks={action.tasks}
              onConfirm={() => resolve({ type: "tasks-confirmed" }))
              onDecline={() => resolve({ type: "tasks-declined" }))
            />
          );
        });
    }
  }
}
```

The TUI components themselves (`InterviewApp`, `PrdReviewView`, `ReviewView`) are unchanged — they don't know about the adapter. The adapter is the glue between the pipeline's action protocol and the existing React components.

## --auto Mode (Future Capability)

With the adapter boundary in place, a fully non-interactive mode becomes straightforward:

```typescript
class AutoPlanningAdapter implements PlanningAdapter {
  async requestAction(action: PlanningAction): Promise<PlanningResponse> {
    switch (action.type) {
      case "interview":
        // Run interview to completion without user input
        // (agent drives the conversation autonomously)
        return { type: "interview-complete", prdMarkdown: await autoInterview(action) };
      case "approve-prd":
        // Auto-approve the PRD
        return { type: "prd-approved", finalizedPrd: action.prdMarkdown };
      case "review-tasks":
        // Auto-confirm the task list
        return { type: "tasks-confirmed" };
    }
  }
}
```

A `synth run --auto` command would:
1. Create an `AutoPlanningAdapter`.
2. Run the `PlanningPipeline` (interview auto-completes, PRD and tasks auto-approve).
3. Run the `ExecutionPipeline`.
4. Run the `FinalizePipeline`.

All without user interaction. This is the natural endpoint of full frontend/backend separation — every decision point flows through an adapter, and the adapter decides whether to ask a human or auto-approve.

## Implementation Plan

### Step 1: Define the PlanningAdapter interface

Create `src/planning/types.ts` with the `PlanningAction`, `PlanningResponse`, and `PlanningAdapter` types. No behavioral changes — just type definitions.

### Step 2: Extract PlanningPipeline

Create `src/planning/pipeline.ts`. Move the phase orchestration logic from `start.tsx` into the pipeline, calling `adapter.requestAction()` instead of rendering directly. Wire `start.tsx` to use the pipeline.

### Step 3: Create TuiPlanningAdapter

Create `src/planning/tui-adapter.ts`. Move the Promise-modal rendering patterns from `start.tsx` into the adapter. The existing TUI components are reused unchanged.

### Step 4: Wire resume.tsx to PlanningPipeline

Replace the duplicated planning logic in `resume.tsx` with a `PlanningPipeline` call using `resumeFrom`. This eliminates the code duplication between start and resume.

### Step 5: Add non-TUI CliPlanningAdapter

Create `src/planning/cli-adapter.ts` for the existing non-TUI path (plain stdin/stdout prompts). This replaces the separate non-TUI code paths currently inline in `start.tsx`.

### Step 6: Add AutoPlanningAdapter (--auto mode)

Create `src/planning/auto-adapter.ts` and wire it to a `--auto` flag. This is the capstone — proof that the separation works.

## Relationship to Phase 1

Phase 1 established the pattern for the **execution** path:

- `ConversationEngine` orchestrates the task loop (pipeline role)
- `AgentAdapter` abstracts the AI agent subprocess (adapter role)
- TUI components observe engine events but don't drive the loop

Phase 2 applies the identical pattern to the **planning** path:

- `PlanningPipeline` orchestrates interview → PRD → tasks → review
- `PlanningAdapter` abstracts user interaction decisions
- TUI components present decisions but don't own the flow

The two pipelines compose naturally:

```
synth start:   PlanningPipeline → ExecutionPipeline → FinalizePipeline
synth resume:  PlanningPipeline? → ExecutionPipeline → FinalizePipeline
synth run:     PlanningPipeline(auto) → ExecutionPipeline → FinalizePipeline(auto)
```

Phase 1's `AgentAdapter` remains the pattern to follow: a clean interface with multiple implementations (`ClaudeAdapter`, `CodexAdapter`) that the pipeline doesn't need to know about. `PlanningAdapter` follows the same approach with `TuiPlanningAdapter`, `CliPlanningAdapter`, and `AutoPlanningAdapter`.
