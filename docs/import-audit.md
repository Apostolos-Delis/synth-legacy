# Import Audit: Startup Performance (US-012)

## Baseline Measurements

| Command          | Avg Startup (5 runs) |
|-----------------|---------------------|
| `synth version` | ~75ms               |
| `synth help`    | ~80ms               |

Measured on macOS (Darwin 25.2.0), Bun runtime.

## Import Timing Breakdown

Profiled with `scripts/profile-imports.ts` (averaged across 3 runs):

### Third-Party Dependencies (heaviest)

| Module           | Avg Load (ms) | Eagerly Loaded? | Needed For          |
|-----------------|---------------|-----------------|---------------------|
| `@opentui/core` | ~50–63        | **YES** (via `tui/theme.ts`) | TUI rendering, `boldAttr()` |
| `node-notifier`  | ~17–34        | No (dynamic import) | Notifications after run |
| `@opentui/react` | ~10–14        | No (via `loadTui()`) | TUI rendering        |
| `smol-toml`      | ~2–5          | YES (via `config/loader.ts`) | Config parsing       |
| `react`          | ~0.02         | No (via `loadTui()`) | TUI components       |

### Internal Modules (by cost)

| Module                 | Avg Load (ms) | Eagerly Loaded? | Needed For               |
|-----------------------|---------------|-----------------|--------------------------|
| `interview/interviewer` | ~1.25        | YES             | `plan` command only      |
| `engine/engine`         | ~1.10        | YES             | `run`/`resume` only      |
| `tui/themes/resolve`    | ~0.83        | YES             | Theme resolution         |
| `config/loader`         | ~0.78        | YES             | All commands except version/help |
| `agents/registry`       | ~0.64        | YES             | `run`/`plan`/`finalize`  |
| `finalize/finalize`     | ~0.66        | YES             | `finalize` command only  |
| `plans/registry`        | ~0.62        | YES             | Most commands            |
| `tasks/store`           | ~0.28        | YES             | Most commands            |
| `tui/spinner`           | ~0.13        | YES             | TUI spinner display      |
| `session/session`       | ~0.01        | YES             | `run`/`resume`/`status`  |

### Node Built-ins

| Module             | Avg Load (ms) | Eagerly Loaded? | Notes                    |
|-------------------|---------------|-----------------|--------------------------|
| `node:path`        | ~3.33         | YES             | Used everywhere (keep)   |
| `node:readline`    | ~1.20         | No (dynamic)    | Already deferred         |
| `node:fs/promises` | ~0.90         | YES (via utils/fs) | Used everywhere        |
| `node:os`          | ~0.33         | YES (via session) | Hostname for locks      |

## Critical Finding: `tui/theme.ts` → `@opentui/core`

The single largest startup cost is `@opentui/core` (~50ms), which is **eagerly loaded** because `src/tui/theme.ts` imports `createTextAttributes` at the top level:

```typescript
// src/tui/theme.ts:1
import { createTextAttributes } from "@opentui/core";
```

This import is pulled in by `cli.tsx` line 30:
```typescript
import { ansi, fmt, STATUS_ICONS, ... } from "./tui/theme.js";
```

The `createTextAttributes` function is only used by the lazy `boldAttr()` helper, but the import itself forces the entire `@opentui/core` package to load. This ~50ms cost is paid even for `synth version`.

## What's Already Deferred

The codebase already defers several imports correctly:

1. **TUI components** — `loadTui()` dynamically imports `@opentui/core`, `@opentui/react`, `App`, `InterviewApp`, `GeneratingView`, `ReviewView`
2. **node-notifier** — `await import("./notifications.js")` in cmdRun
3. **node:readline** — `await import("node:readline")` in cmdPlan

However, the `tui/theme.ts` → `@opentui/core` eager import negates the `loadTui()` deferral.

## Deferral Candidates for US-013

### Tier 1: High Impact (>5ms savings)

| Module | Current Cost | Action | Expected Savings |
|--------|-------------|--------|-----------------|
| `@opentui/core` (via `tui/theme.ts`) | ~50ms | Lazy-import `createTextAttributes` in `boldAttr()` | ~50ms |
| `node-notifier` | ~25ms | Already deferred ✓ | — |

### Tier 2: Medium Impact (1–5ms savings)

| Module | Current Cost | Action | Expected Savings |
|--------|-------------|--------|-----------------|
| `smol-toml` (via `config/loader.ts`) | ~3ms | Defer config loading; version/help don't need it | ~3ms |
| `interview/interviewer` | ~1.25ms | Defer to `cmdPlan()` | ~1.25ms |
| `engine/engine` | ~1.1ms | Defer to `cmdRun()`/`cmdResume()` | ~1.1ms |

### Tier 3: Low Impact (<1ms savings)

| Module | Current Cost | Action | Expected Savings |
|--------|-------------|--------|-----------------|
| `tui/themes/resolve` | ~0.83ms | Defer to `applyTheme()` | ~0.83ms |
| `config/loader` | ~0.78ms | Defer to commands that use config | ~0.78ms |
| `finalize/finalize` | ~0.66ms | Defer to `cmdFinalize()` | ~0.66ms |
| `agents/registry` | ~0.64ms | Defer to commands using agents | ~0.64ms |
| `plans/registry` | ~0.62ms | Defer to commands using plans | ~0.62ms |
| `tasks/store` | ~0.28ms | Defer to commands using tasks | ~0.28ms |
| `tasks/planner` | ~0.16ms | Defer to `cmdPlan()` | ~0.16ms |
| `tui/spinner` | ~0.13ms | Defer to TUI commands | ~0.13ms |
| `tui/spinners` | ~0.01ms | Defer to themes command | ~0.01ms |

### Total Estimated Savings

| Tier | Savings |
|------|---------|
| Tier 1 | ~50ms |
| Tier 2 | ~5ms |
| Tier 3 | ~4ms |
| **Total** | **~59ms** |

With all deferrals applied, `synth version` should drop from ~75ms to ~16ms (Bun runtime + node:path + tui/theme ANSI constants only).

## Command → Module Dependency Map

| Command    | Required Eager Imports | Can Defer Everything Else |
|-----------|----------------------|--------------------------|
| `version`  | `tui/theme` (ANSI only) | All others |
| `help`     | `tui/theme` (ANSI only) | All others |
| `init`     | `tui/theme`, `utils/fs` | All others |
| `ls`       | `tui/theme`, `plans/registry`, `tasks/store` | All others |
| `show`     | `tui/theme`, `plans/registry`, `tasks/store`, `utils/fs` | All others |
| `status`   | `tui/theme`, `plans/registry`, `tasks/store`, `session/session` | All others |
| `config`   | `tui/theme`, `config/loader`, `tui/themes/*` | All others |
| `themes`   | `tui/theme`, `config/loader`, `tui/themes/*`, `tui/spinners` | All others |
| `plan`     | Nearly everything (config, agents, interviewer, tasks, TUI) | `engine`, `finalize` |
| `run`      | Nearly everything (config, agents, engine, tasks, TUI) | `finalize`, `interviewer` |
| `finalize` | config, agents, finalize, tasks, plans | `engine`, `interviewer`, TUI components |

## Reproduction

```bash
# Run the import profiler
bun scripts/profile-imports.ts

# Measure baseline startup
time bun src/cli.tsx version

# Measure with profiling enabled
bun src/cli.tsx run --profile 2>/dev/null
```
