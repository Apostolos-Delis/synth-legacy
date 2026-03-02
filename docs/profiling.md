# Profiling

Synth has two profiling systems: a **macro profiler** for engine-level phase timing, and a **TUI profiler** for per-component render timing. Both activate when you pass `--profile`.

## Quick Start

```bash
# Run with profiling enabled
./dist/synth resume <session-id> --profile

# Interact with the TUI (scroll with j/k, switch tasks, wait for streaming)
# Press q to quit

# The macro profile prints to stdout on exit
# The TUI profile writes to the session logs directory
```

## Macro Profiler (`--profile`)

Measures wall-clock time for engine-level phases: task selection, prompt building, agent execution, etc.

```
┌─ Performance Profile ─────────────────────────────────────┐
  Phase                            Duration (ms)   % Total
  ────────────────────────────────────────────────────────
  engine:task-selection                     0.05      0.0%
  build:read-files                          0.42      0.0%
  engine:agent-execution                19197.12    100.0%
  agent:spawn                               0.37      0.0%
  tui:first-token-render                    0.13      0.0%
  ────────────────────────────────────────────────────────
  Total                                 19199.68
└───────────────────────────────────────────────────────────┘
```

**Source:** `src/utils/perf.ts` — `PerfTrace` class with `startPhase`/`endPhase`/`recordPhase`.

**Key phases:**
| Phase | What it measures |
|-------|-----------------|
| `engine:task-selection` | Picking the next task to execute |
| `build:read-files` | Reading project files for the prompt |
| `engine:prompt-build` | Full prompt construction |
| `engine:agent-execution` | Wall-clock time of the LLM API call |
| `agent:spawn` | Subprocess creation time |
| `tui:first-token-render` | Time from first streaming token to screen |

## TUI Profiler (`--profile`)

Measures per-component React render times, event counts, and memory usage. Data is written to `tui-profile.jsonl` in the session logs directory.

### Finding the profile data

```bash
# Find the most recent profile
find ~/.synth/sessions -name 'tui-profile.jsonl' | xargs ls -t | head -1

# Or for a specific session
cat ~/.synth/sessions/<repo>/<project>/<session-id>/logs/tui-profile.jsonl
```

### Profile format

Each line is a JSON object representing one second of data:

```json
{
  "ts": "2026-02-27T22:43:13.000Z",
  "spans": [
    { "name": "App", "count": 6, "totalMs": 0.1, "maxMs": 0.02, "minMs": 0.01, "avgMs": 0.02 },
    { "name": "OutputPane", "count": 6, "totalMs": 0.05, "maxMs": 0.01, "minMs": 0.01, "avgMs": 0.01 },
    { "name": "TaskSidebar", "count": 6, "totalMs": 0.8, "maxMs": 0.2, "minMs": 0.1, "avgMs": 0.13 }
  ],
  "events": {
    "tui:render:serial": 2,
    "tui:manual-select": 6,
    "engine:agent:tool": 1
  },
  "mem": { "rss": 122000000, "heapTotal": 27000000, "heapUsed": 115000000 }
}
```

### Analyzing profile data

**Full timeline with per-second breakdown:**

```bash
cat <profile-path> | python3 -c "
import json, sys
for line in sys.stdin:
    d = json.loads(line)
    events = d.get('events', {})
    spans = {s['name']: s for s in d.get('spans', [])}
    app = spans.get('App', {})
    op = spans.get('OutputPane', {})
    jk = events.get('tui:manual-select', 0)
    renders = events.get('tui:render:serial', 0)
    stdout = events.get('engine:agent:stdout', 0)
    tool = events.get('engine:agent:tool', 0)
    react_ms = sum(s.get('totalMs', 0) for s in d.get('spans', []) if s['name'] not in ('renderer:frame', 'renderer:loop'))
    print(f'{d[\"ts\"][11:19]} react={react_ms:>5.1f}ms | App:{app.get(\"count\",0):>2} OP:{op.get(\"count\",0):>2} | j/k:{jk:>2} stream:{stdout+tool} renders:{renders}')
"
```

**Aggregate component render costs:**

```bash
cat <profile-path> | python3 -c "
import json, sys
lines = [json.loads(l) for l in sys.stdin if l.strip()]
all_spans = {}
for d in lines:
    for s in d.get('spans', []):
        n = s['name']
        if n not in all_spans:
            all_spans[n] = {'count': 0, 'totalMs': 0, 'maxMs': 0}
        all_spans[n]['count'] += s['count']
        all_spans[n]['totalMs'] += s['totalMs']
        all_spans[n]['maxMs'] = max(all_spans[n]['maxMs'], s['maxMs'])
dur = max(1, len(lines))
for n, d in sorted(all_spans.items(), key=lambda x: -x[1]['totalMs']):
    if d['totalMs'] < 0.1: continue
    avg = d['totalMs'] / d['count'] if d['count'] else 0
    print(f'  {n:<30} {d[\"count\"]/dur:>5.1f}/sec  total={d[\"totalMs\"]/dur:>5.1f}ms/sec  avg={avg:>5.2f}ms  max={d[\"maxMs\"]:>5.1f}ms')
"
```

**Show only keyboard navigation seconds (detecting choppy scrolling):**

```bash
cat <profile-path> | python3 -c "
import json, sys
for line in sys.stdin:
    d = json.loads(line)
    jk = d.get('events', {}).get('tui:manual-select', 0)
    if jk == 0: continue
    spans = {s['name']: s for s in d.get('spans', [])}
    app = spans.get('App', {})
    tdh = spans.get('TaskDetailHeader', {})
    sb = spans.get('TaskSidebar', {})
    op = spans.get('OutputPane', {})
    react_ms = app.get('totalMs',0) + tdh.get('totalMs',0) + sb.get('totalMs',0) + op.get('totalMs',0)
    print(f'{d[\"ts\"][11:19]} j/k:{jk:>2} | App:{app.get(\"count\",0):>2} react={react_ms:.1f}ms | TDH:{tdh.get(\"totalMs\",0):.1f}ms SB:{sb.get(\"totalMs\",0):.1f}ms OP:{op.get(\"totalMs\",0):.1f}ms')
"
```

### Spans reference

| Span | Component | What it measures |
|------|-----------|-----------------|
| `App` | `App.tsx` | Root component render (keyboard handling, view routing) |
| `ExecutionView` | `ExecutionView.tsx` | Main execution layout (sidebar + output + header + status) |
| `OutputPane` | `OutputPane.tsx` | Output content rendering (line splitting, tool coloring) |
| `OutputPane:parse` | `OutputPane.tsx` | Output block parsing (when using block parser) |
| `OutputPane:renderBlocks` | `OutputPane.tsx` | Block-to-JSX conversion |
| `TaskSidebar` | `TaskSidebar.tsx` | Task list with status indicators |
| `TaskDetailHeader` | `TaskDetailHeader.tsx` | Selected task details (description, criteria) |
| `Header` | `Header.tsx` | Top bar (project name, progress, elapsed) |
| `StatusBar` | `StatusBar.tsx` | Bottom bar (status, nav hints, tokens) |
| `tui:render:serial:notify` | `tui-adapter.ts` | Time for `_notify()` → React setState |
| `tui:wrapText` | `utils.ts` | Text wrapping utility |

### Events reference

| Event | Source | What it counts |
|-------|--------|---------------|
| `tui:render:serial` | `tui-adapter.ts` | Serial render triggers (from engine events) |
| `tui:render:parallel` | `tui-adapter.ts` | Parallel render triggers |
| `tui:manual-select` | `App.tsx` | j/k keypresses (task navigation) |
| `tui:auto-follow` | `App.tsx` | Auto-selection when new task starts |
| `engine:agent:stdout` | `tui-adapter.ts` | Streaming text chunks from agent |
| `engine:agent:tool` | `tui-adapter.ts` | Tool use/result events from agent |
| `engine:agent:stderr` | `tui-adapter.ts` | Agent stderr output |
| `engine:iteration:start` | `tui-adapter.ts` | New iteration beginning |
| `app:mount` | `App.tsx` | App component mounted (session start) |
| `app:unmount` | `App.tsx` | App component unmounted (session end) |
| `renderer:requestRender` | `tui-adapter.ts` | @opentui requestRender calls (only with `SYNTH_TUI_PROFILE=1`) |

### Interpreting results

**Healthy profile:**
- React total: < 5ms/sec during scrolling
- App renders ≈ j/k presses (1:1 ratio)
- OutputPane: < 0.1ms avg
- Header/StatusBar: renders only 1-2x/sec (memo working)

**Red flags:**
- React total > 20ms/sec → excessive component re-renders
- App renders >> j/k presses → unnecessary re-renders from `_notify`
- OutputPane > 1ms avg → output parsing too expensive
- Header/StatusBar rendering on every j/k → memo comparator broken
- `renderer:requestRender` > 5000/sec → render storm from scrollbox

### Environment variables

| Variable | Effect |
|----------|--------|
| `SYNTH_TUI_PROFILE=1` | Enable TUI profiler (also enabled by `--profile`) |

## Tips

- Always compare against a known-fast baseline (e.g., ralph-tui)
- Profile data accumulates across runs in the same session — look at the latest `app:mount` event to find the start of the current run
- Memory (`mem.rss`) growing over time indicates a leak
- The `renderer:frame` span reports garbage deltaTime values in Bun compiled binaries — ignore it
