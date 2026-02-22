# Terminal UI

Synth includes a terminal-based UI built with [OpenTUI](https://github.com/nicktomlin/opentui) and React. The TUI provides real-time visibility into the interview, execution, and task management phases.

## Architecture

The TUI uses OpenTUI's React bindings (`@opentui/react`) to render terminal components declaratively. The component tree mirrors a standard React application, with state flowing down through props.

```
App (keyboard nav + view routing)
  |
  +-- InterviewView (chat-style Q&A)
  |     +-- Header
  |     +-- ChatPane
  |     +-- Footer
  |
  +-- ExecutionView (split-pane agent monitor)
  |     +-- Header
  |     +-- TaskSidebar (left)
  |     +-- OutputPane (right)
  |     +-- StatusBar
  |
  +-- DashboardView (task table)
        +-- Header
        +-- Task table
        +-- Footer
```

## TUI State

```typescript
type ViewMode = "execution" | "dashboard" | "interview";

interface TuiState {
  view: ViewMode;
  engineState: EngineState;
  iteration: number;
  maxIterations: number;
  tasks: Task[];
  currentTaskId: string | null;
  output: string;
  agentName: string;
  planId: string;
  startTime: number;
  interviewMessages: InterviewMessage[];
}
```

State is updated in response to engine events (`task:start`, `agent:stdout`, `state:change`, etc.) and user input (keyboard shortcuts).

## Views

### InterviewView

Displays during `synth plan`. A chat-style interface showing the conversation between the user and the AI interviewer.

```
┌─ Synth ─ plan: bold-falcon-42 ─────────────────┐
│                                                  │
│  Synth: What problem are you trying to solve?    │
│                                                  │
│  User: I need a REST API for managing tasks...   │
│                                                  │
│  Synth: Great. Let me ask about the data model.  │
│  What fields should a task have?                 │
│                                                  │
│──────────────────────────────────────────────────│
│  [Enter] Send  [Ctrl+C] Quit                     │
└──────────────────────────────────────────────────┘
```

### ExecutionView

Displays during `synth run`. A split-pane layout with the task list on the left and agent output on the right.

```
┌─ Synth ─ plan: bold-falcon-42 ── iter 3/20 ── claude ── 2m 15s ─┐
│                      │                                            │
│  ✓ US-001 Setup DB   │  > Reading src/models/task.ts...           │
│  ✓ US-002 Add routes │  > Adding validation to create endpoint    │
│ >◐ US-003 Auth       │  > Running bun test...                     │
│  ○ US-004 Tests      │  > 12 tests passed                        │
│  ○ US-005 Docs       │                                            │
│                      │                                            │
├──────────────────────┴────────────────────────────────────────────┤
│  RUNNING │ claude │ iter 3/20 │ 2m 15s │ [d] dashboard [p] pause │
└───────────────────────────────────────────────────────────────────┘
```

The task sidebar takes ~30% width (max 40 characters). Tasks show status icons, priority colors, and a `>` marker for the current task.

### DashboardView

A full-width task table toggled with `d` during execution.

```
┌─ Synth ─ plan: bold-falcon-42 ─────────────────────────┐
│                                                          │
│  ID      Title              Status    Pri   Iterations   │
│  US-001  Setup database     ✓ done     1        1        │
│  US-002  Add API routes     ✓ done     1        1        │
│  US-003  Authentication     ◐ active   2        1        │
│  US-004  Write tests        ○ open     3        0        │
│  US-005  Documentation      ○ open     4        0        │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  [d] execution  [q] quit                                 │
└──────────────────────────────────────────────────────────┘
```

## Components

### Header

Displays project name, plan ID, current iteration, agent name, and elapsed time. Time formats adaptively: seconds, then minutes + seconds, then hours + minutes + seconds.

### TaskSidebar

Scrollable task list with:
- **Status icons**: `○` open, `◐` in progress, `✓` done, `✗` failed, `⊘` skipped
- **Priority colors**: P1 red, P2 yellow, P3 cyan, P4/P5 gray
- **Current task marker**: `>` prefix
- **Overflow indicator**: Shows `+N more` when tasks exceed available height

### OutputPane

Tail view of agent stdout. Shows the last N lines that fit within the available terminal height. Content scrolls automatically as new output arrives.

### StatusBar

Single-line bar showing:
- Engine state with color coding: IDLE (gray), RUNNING (green), PAUSED (yellow), BLOCKED (red), DONE (green), FAILED (red)
- Agent name
- Iteration counter (`iter N/M`)
- Elapsed time
- Keyboard shortcut hints

### ChatPane

Scrollable message list for the interview view. Messages are prefixed with `User:` or `Synth:` and word-wrapped to terminal width.

### Footer

Context-sensitive keyboard shortcut hints that change per view.

## Keyboard Shortcuts

| Key | Context | Action |
|-----|---------|--------|
| `d` | Execution | Toggle between execution and dashboard views |
| `p` | Execution | Pause / resume the engine |
| `q` | Any | Quit (from dashboard: switch to execution first) |
| `Escape` | Any | Quit (from dashboard: switch to execution first) |

## Theme

Defined in `src/tui/theme.ts`. Uses ANSI escape codes for terminal-safe rendering:

| Token | Color |
|-------|-------|
| `primary` | Cyan |
| `success` | Green |
| `warning` | Yellow |
| `error` | Red |
| `muted` | Gray |
| `bold` | Bold |
| `blue` | Blue |
| `magenta` | Magenta |
