# Terminal UI

Synth includes a terminal-based UI built with [OpenTUI](https://github.com/nicktomlin/opentui) and React. The TUI provides real-time visibility into the interview, execution, and task management phases.

## Architecture

The TUI uses OpenTUI's React bindings (`@opentui/react`) to render terminal components declaratively. The component tree mirrors a standard React application, with state flowing down through props.

```
App (keyboard nav + view routing)
  |
  +-- InterviewApp (chat-style Q&A)
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
  |     +-- Header
  |     +-- Task table
  |     +-- Footer
  |
  +-- FinalizeApp (finalize conversation)
        +-- Header
        +-- ChatPane
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
  sessionId: string;
  startTime: number;
  isThinking: boolean;
  interviewMessages: InterviewMessage[];
}
```

State is updated in response to engine events (`task:start`, `agent:stdout`, `state:change`, etc.) and user input (keyboard shortcuts).

## Views

### InterviewView

Displays during `synth start`. A chat-style interface showing the conversation between the user and the AI interviewer.

```
┌─ Synth ─ session: bold-falcon-42 ─────────────────┐
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

Displays during execution. A split-pane layout with the task list on the left and agent output on the right.

```
┌─ Synth ─ session: bold-falcon-42 ── iter 3/20 ── claude ── 2m 15s ─┐
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
┌─ Synth ─ session: bold-falcon-42 ─────────────────────────┐
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

Displays project name, session ID, current iteration, agent name, and elapsed time. Time formats adaptively: seconds, then minutes + seconds, then hours + minutes + seconds.

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

## Themes

Synth ships with a configurable theme system. Set the theme in `synth.toml`:

```toml
[tui]
theme = "catppuccin"
spinner = "dots"
```

### Built-in Themes

| Name | Description |
|------|-------------|
| `tokyonight` | Cool blue tones inspired by Tokyo Night (default) |
| `onedark` | Atom One Dark — muted blues and purples |
| `catppuccin` | Catppuccin Mocha — pastel palette on a dark base |
| `dracula` | Dracula — vibrant purples and pinks |
| `solarized` | Solarized Dark — Ethan Schoonover's precision palette |
| `nord` | Nord — arctic, bluish-grey tones |
| `gruvbox` | Gruvbox Dark — retro warm earth tones |

### Custom Themes

Place a `.toml` file in `~/.config/synth/themes/` and reference it by filename (without extension):

```toml
# synth.toml
[tui]
theme = "my-theme"   # loads ~/.config/synth/themes/my-theme.toml
```

A custom theme file must define all 16 color keys across 5 sections:

```toml
# ~/.config/synth/themes/my-theme.toml

[bg]
primary   = "#1a1b26"
secondary = "#24283b"
highlight = "#292e42"

[fg]
primary   = "#c0caf5"
secondary = "#a9b1d6"
muted     = "#565f89"
dim       = "#3b4261"

[status]
success = "#9ece6a"
warning = "#e0af68"
error   = "#f7768e"
info    = "#7dcfff"

[accent]
primary   = "#7aa2f7"
secondary = "#bb9af7"

[border]
normal = "#3b4261"
active = "#7aa2f7"
muted  = "#292e42"

# Optional: override the default spinner for this theme
defaultSpinner = "dots"
```

### Spinners

Each theme has a default spinner (`braille`), which can be overridden in `synth.toml` or per custom theme file.

| Preset | Frames |
|--------|--------|
| `dots` | `⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷` |
| `braille` | `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` |
| `line` | `- \ \| /` |
| `moon` | `🌑 🌒 🌓 🌔 🌕 🌖 🌗 🌘` |
| `bounce` | `⠁ ⠂ ⠄ ⠂` |
| `arc` | `◜ ◠ ◝ ◞ ◡ ◟` |
| `box` | `▖ ▘ ▝ ▗` |
| `arrows` | `← ↖ ↑ ↗ → ↘ ↓ ↙` |

### `synth themes` Command

Run `synth themes` to list all available themes and spinner presets in your terminal. The output shows built-in themes, any custom themes discovered in `~/.config/synth/themes/`, and all spinner preset names with their frames.

### Theme Resolution Order

When resolving the `theme` value from `synth.toml`:

1. **Built-in** — match against the 7 built-in theme names
2. **Custom directory** — look for `~/.config/synth/themes/<name>.toml`
3. **Absolute path** — if the value is an absolute path ending in `.toml`, load it directly
4. **Error** — print available themes and exit
