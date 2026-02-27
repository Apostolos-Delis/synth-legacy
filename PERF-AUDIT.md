# Full Codebase Performance Audit

Every source file in `src/` has been read and analyzed for performance issues.
Findings are grouped by file, with a checkbox marking each file as reviewed.

---

## Pipeline + Engine

- [x] `src/pipeline/execution-pipeline.ts`
  - **Lazy imports are never cached.** Every `lazy*()` function (e.g., `lazyLogger()`, `lazyGit()`, `lazyRunModule()`) performs a dynamic `import()` on every invocation. Should cache after first resolution.
  - **`appendChunk` allocates a new object on every streaming chunk** via `state = { ...state, buffer: state.buffer + chunk }`. For long review outputs this is O(n²) in total string length.
  - **`getState()` copies the entire tasks array** with `[...this.tasks]` on every call.
  - **`forwardEngineEvent()` does a linear `this.tasks.find()` scan per engine event** for task:start/complete/failed, plus creates a shallow copy `{ ...task }` for each emitted event.

- [x] `src/pipeline/tui-adapter.ts`
  - **🔴 HOT PATH: String concatenation on every streaming chunk (line 383):** `this.tuiData.output += stripped` grows a single string up to 100KB. After the limit, `this.tuiData.output.slice(-MAX_OUTPUT_LENGTH)` allocates a new ~100KB string on every subsequent chunk. This is the single most expensive per-token operation.
  - **`stripAnsi()` called per chunk (line 381):** Regex-based ANSI stripping on every stdout event.
  - **`appendTaskOutput()` called per chunk (line 388):** Another string concatenation + possible slice per chunk.
  - **Token usage rebuild on every `iteration:end`:** `this.tuiData.tasks.map(...)` with `.filter()` iterates all tasks.
  - **Un-throttled `renderSerial()` for most event types (line 463):** Only `agent:stdout` and `agent:tool` use the 80ms throttled path. All other events call `this.renderSerial()` directly.
  - **`JSON.stringify(config, null, 2)` stored as `configDisplay`:** Wastes memory for session lifetime.

- [x] `src/pipeline/types.ts`
  - No performance concerns (pure type definitions).

- [x] `src/pipeline/log-adapter.ts`
  - **`process.stdout.write(event.message)` is synchronous blocking I/O** executed on every `agent:stdout` chunk during streaming. Can block the event loop.

- [x] `src/pipeline/index.ts`
  - No performance concerns (re-exports only).

- [x] `src/engine/engine.ts`
  - **🔴 HOT PATH: Unbounded string accumulation in `onStdout` (line 396):** `output += stripped` grows without bound for the entire iteration.
  - **🔴 HOT PATH: Three separate regex operations per streaming chunk:** `parseAcDoneMarkers` + `stripAcDoneMarkers` + `COMPLETION_PATTERN.replace` all run on every chunk.
  - **Three separate `loadTasks()` file reads per iteration** (lines 303, 438, 454): Each reads the tasks file from disk and JSON-parses it. Two reads are back-to-back.
  - **`detectRateLimit(result.stdout + result.stderr)`:** Concatenates two potentially large strings to test 7 regex patterns.
  - **`parseTokenUsageFromOutput` splits entire output by `\n`:** Allocates array of all lines for potentially very large output, then only uses last 50.

- [x] `src/engine/types.ts`
  - No performance concerns.

- [x] `src/engine/output-index.ts`
  - Sequential file I/O in `loadTaskOutput()`: Reads log files one at a time. Could parallelize.
  - `chunks.join("")`: Concatenates all loaded file contents into a single string.

- [x] `src/engine/tokens.ts`
  - **`output.split("\n")` in `parseTokenUsageFromOutput()`:** Splits entire agent output (100KB+) into array then only inspects last 50. Should scan backwards.
  - `TokenAccumulator.getSessionTotal()` creates spread copies on every call.

- [x] `src/engine/backpressure.ts`
  - Sequential command execution: Independent health checks could run in parallel.

- [x] `src/engine/circuit-breaker.ts`
  - No performance concerns.

- [x] `src/engine/rate-limit.ts`
  - Tests 7 regex patterns against entire output string. Could test truncated suffix.

- [x] `src/engine/ac-done.ts`
  - **🔴 HOT PATH: `parseAcDoneMarkers()` creates a new RegExp on every call (line 6):** `new RegExp(AC_DONE_PATTERN.source, AC_DONE_PATTERN.flags)` allocates a fresh regex per streaming chunk because the global regex has mutable `lastIndex` state.
  - **🔴 HOT PATH: `stripAcDoneMarkers()` creates a new inline regex per call (line 14):** Also hot-path per chunk.

- [x] `src/engine/prompt-cache.ts`
  - `logHit()`/`logMiss()` allocate metadata objects on every cache access, even if logger discards debug-level messages.
  - `stat()` syscall on every `readText()` call to check mtime freshness.

- [x] `src/engine/prd-review.ts`
  - `output += chunk` in `onStdout` callback: String concatenation per chunk, but one-off operation. Low impact.

---

## TUI Core

- [x] `src/tui/App.tsx`
  - **Object spread on every render (line 142):** `const executionState: TuiState = { ...engineData, view: "execution" }` allocates a new object every render. Should use `useMemo`.
  - **Leaked profiler span on completion path:** `startSpan("App")` called but `endSpan` only reached in non-completion branch.
  - 10+ ref synchronization assignments per render (lines 74-91).

- [x] `src/tui/ExecutionView.tsx`
  - **🔴 Forced 1-second re-render via `setInterval` (lines 25-29):** `tick((n) => n + 1)` every 1000ms triggers a full component re-render during execution/reviewing states. No memoization anywhere.
  - **`tasks.filter()` per render (line 40):** Linear scan on every render including the 1-second tick. Should use `useMemo`.
  - **`displayOutput.slice(-256)` per render (line 63):** Creates new string every render for `outputSignature`.
  - **Component is not `memo`'d.** Every parent re-render causes full re-render of ExecutionView and all children.

- [x] `src/tui/ParallelExecutionView.tsx`
  - Same forced 1-second re-render pattern.
  - Same `tasks.filter()` per render.
  - Complex layout math on every render (lines 59-89) — should be memoized.
  - Not `memo`'d, no `useMemo` anywhere.

- [x] `src/tui/ParallelBridge.tsx`
  - **🔴 `isTypableChar` allocates a new `Set` on every call (lines 25-36):** The `new Set([...])` is inside the function body. Should be a module-level constant.
  - `onQuit={overlayActive ? undefined : onQuit}` creates new prop identity on overlay state change.

- [x] `src/tui/DashboardView.tsx`
  - **Four separate `.filter()` calls on tasks array per render (lines 38-41).** Should be a single-pass reduce.
  - `tasks.map()` in JSX creates new ReactNode tree for every task on every render.
  - Not `memo`'d, no `useMemo` on any derived values.

- [x] `src/tui/HistoryView.tsx`
  - `outputText.split("\n").map(...)` in detail mode: Splits potentially large output string every render.
  - `handleKey` callback recreated on every j/k press due to `selectedEntry` dependency.

- [x] `src/tui/ConfigView.tsx`
  - `state.configDisplay.split("\n")` on every render, not memoized.
  - Regex match per line per render. Low practical impact since rarely displayed.

- [x] `src/tui/CompletionView.tsx`
  - `commitRows` construction loop per render with `normalizeCommitSubject()` regex. Could be memoized.
  - Low impact — mostly-static summary view.

- [x] `src/tui/FinalizeApp.tsx`
  - `MessageBubble` inner component not memoized. During streaming, all bubbles re-render.
  - `useKeyboard` callback depends on `messages`, recreated on every new message.

- [x] `src/tui/GeneratingView.tsx`
  - No performance concerns.

- [x] `src/tui/InterviewApp.tsx`
  - `MessageBubble` not memoized. Re-renders all bubbles on every streaming chunk.
  - All `MessageBubble`s receive `streamingText`/`toolEvents` as props, defeating future memoization.

- [x] `src/tui/LogView.tsx`
  - **🔴 `setEntries([...buf])` on every log entry (line 57):** Copies entire buffer (up to 10,000 entries) per log line. O(n) per log entry.
  - **No virtualization.** Rendering 10,000 `<text>` elements is extremely expensive.
  - `formatTimestamp()` called per entry per render.

- [x] `src/tui/PrdReviewView.tsx`
  - No streaming hot-path concerns.

- [x] `src/tui/ReviewView.tsx`
  - `tasks.reduce()` not memoized. `TaskListPane`/`TaskDetailPane` not `memo`'d.

- [x] `src/tui/types.ts`
  - No performance concerns.

- [x] `src/tui/utils.ts`
  - Profiler calls in `wrapText` add overhead when enabled. Otherwise clean.

- [x] `src/tui/profiler.ts`
  - No performance concerns. Zero-cost when disabled.

- [x] `src/tui/task-state.ts`
  - **🔴 HOT PATH: `appendTaskOutput` string concatenation (line 63):** `prev + chunk` creates intermediate string, then `.slice(-maxLength)` creates another. O(n) per chunk where n = accumulated output.

- [x] `src/tui/theme.ts`
  - No performance concerns. Properly lazy-cached.

- [x] `src/tui/spinner.ts`
  - No performance concerns.

- [x] `src/tui/spinners.ts`
  - No performance concerns.

---

## TUI Components

- [x] `src/tui/components/OutputPane.tsx`
  - `renderLabeledLines` closure re-created every render. Calls `expandToolLine` (JSON.parse) and `wrapText` per line.
  - `expandToolLine` calls `JSON.parse`/`JSON.stringify` on every render for every tool line. Never cached.
  - Inline style objects (`verticalScrollbarOptions`, `style={{ flexDirection }}`) create new objects every render.
  - `outputBlocks.map(...)` allocates new ReactNode arrays on every render even when blocks haven't changed.

- [x] `src/tui/components/TaskSidebar.tsx`
  - `padLine` closure re-created every render with `" ".repeat()` per task.
  - Empty row padding uses `Array.from({ length }).map()` — new array every render.
  - Custom comparator `areEqual` is good — prevents most unnecessary re-renders.

- [x] `src/tui/components/Header.tsx`
  - Inline style objects with `backgroundColor` create new objects every render. Should be module-level constants.
  - `miniProgressBar` allocates strings with `.repeat()` every render. Trivial.

- [x] `src/tui/components/StatusBar.tsx`
  - `navHints` computed via large conditional chain every render. Could memoize.
  - Inline style objects.

- [x] `src/tui/components/Footer.tsx`
  - Inline style object. Minor.

- [x] `src/tui/components/PhaseIndicator.tsx`
  - **NOT wrapped in `memo()`.** Re-renders whenever parent re-renders. Embedded inside OutputPane (hot path during streaming).

- [x] `src/tui/components/Spinner.tsx`
  - **🔴 NOT wrapped in `memo()`. 80ms interval (12.5 state updates/sec) per instance.** Each update triggers re-render cascading through non-memoized parents (PhaseIndicator → AgentStreamingBubble → OutputPane). This is a major source of jank during streaming.

- [x] `src/tui/components/TaskDetailHeader.tsx`
  - `wrapText(task.description, innerWidth)` runs every render, not memoized.
  - `task.dependsOn?.filter(Boolean)` creates new array every render.
  - `criteriaRows`/`contentRows` rebuilt every render.

- [x] `src/tui/components/Toast.tsx`
  - `ToastContainer` and `ToastItem` NOT wrapped in `memo()`. Inline style objects. Minor impact since toasts are infrequent.

- [x] `src/tui/components/HelpOverlay.tsx`
  - No performance concerns. Well-optimized.

- [x] `src/tui/components/FormattedText.tsx`
  - `getColorMap()` creates new object literal every render. Should be module-level.

- [x] `src/tui/components/AgentStreamingBody.tsx`
  - **NOT wrapped in `memo()`.** Rendered during active streaming, re-renders on every chunk.
  - `streamingText.replace(/\s+$/, "")` runs regex every render during streaming.
  - Inline style objects.

- [x] `src/tui/components/AgentStreamingBubble.tsx`
  - **NOT wrapped in `memo()`.** Contains PhaseIndicator (not memo'd) which contains Spinner (not memo'd, 80ms timer). Creates cascade: Spinner timer → PhaseIndicator → AgentStreamingBubble → AgentStreamingBody every 80ms during streaming.
  - Inline style objects.

- [x] `src/tui/components/ConfirmationDialog.tsx`
  - No performance concerns. Well-memoized.

- [x] `src/tui/components/ConflictResolutionPanel.tsx`
  - 80ms spinner interval when any file is "ai-resolving".
  - `conflict?.files.some(...)` iterates files array every render.

- [x] `src/tui/components/LogOverlay.tsx`
  - `useTerminalDimensions()` runs even when `visible` is false.

- [x] `src/tui/components/MergeQueuePanel.tsx`
  - **80ms interval updates BOTH `now` and `spinnerFrame`** — two state updates per tick = potential two re-renders per 80ms.
  - `[...items].sort(...)` creates new sorted array every render.
  - Two filter passes over sorted array per render.

- [x] `src/tui/components/OptionSelector.tsx`
  - `toSelectOptions` creates new mapped array every render.
  - Otherwise reasonable.

- [x] `src/tui/components/TaskGraphOverlay.tsx`
  - `ConnectorRow` NOT memoized. Builds two `new Array(totalWidth).fill(" ")` per render.
  - 80ms spinner interval when any task is running.

- [x] `src/tui/components/WorkerPanel.tsx`
  - **80ms interval with dual state updates** (same as MergeQueuePanel).
  - `[...workers].sort(...)` + 4 separate iterations per render, all at 12.5 fps.

- [x] `src/tui/hooks/useAgentStreaming.ts`
  - `appendTool` creates `[...prev, event]` on every tool event. O(n) in accumulated tool events.

- [x] `src/tui/hooks/useDestroyedRef.ts`
  - No performance concerns.

- [x] `src/tui/hooks/useExitConfirm.ts`
  - `requestQuit` gets new identity when `exitArmed` changes. Minor.

- [x] `src/tui/hooks/useInputSizing.ts`
  - No performance concerns.

- [x] `src/tui/hooks/useSyncLineCount.ts`
  - `setTimeout(syncLineCount, 0)` fires on every keystroke. `text.split("\n")` inside allocates per keystroke.

- [x] `src/tui/hooks/useToast.ts`
  - No performance concerns.

---

## Commands

- [x] `src/commands/run.tsx`
  - `applyTheme(cwd)` reads two TOML files on critical startup path.

- [x] `src/commands/resume.tsx`
  - **🔴 `applyTheme(cwd)` called 3+ times in a single flow.** Each reads and parses two TOML files from disk with no caching.
  - `appendChunk` creates new state object with spread + string concat on every streaming chunk.
  - `appendTool` copies and slices entire tool events array on every tool event.
  - `renderCompletionTui` spawns `git log` synchronously, blocking TUI.
  - Sequential `await` chains for independent file I/O.

- [x] `src/commands/start.tsx`
  - **🔴 O(n²) regex scanning during streaming:** `streamOutput.match(/\b[A-Z]{2,5}-\d{3}\b/g)` over entire accumulated output on every chunk.
  - **🔴 Full TUI re-render on every streaming chunk:** `planRoot.render()` called on every `onProgress`/`onTool` with no throttling.
  - `applyTheme(cwd)` called redundantly.
  - String concatenation in hot loop: `streamOutput += chunk`.

- [x] `src/commands/finalize.tsx`
  - Duplicate `applyTheme` and `loadTui` definitions.
  - Per-message regex matching + `tasks.find()` linear scan.
  - Serial TUI throttle at 16ms (should also be increased).

- [x] `src/commands/index.ts`
  - **All 15 command modules eagerly imported at startup.** Even `synth version` pays full module loading cost.

- [x] `src/commands/helpers.ts`
  - **`applyTheme(cwd)` has no caching.** Every call reads two TOML files from disk.

- [x] `src/commands/config.ts`
  - No performance concerns.

- [x] `src/commands/doctor.ts`
  - No performance concerns.

- [x] `src/commands/init.ts`
  - No performance concerns.

- [x] `src/commands/logs.ts`
  - `readText` reads entire log file even for `--tail` mode.
  - Duplicated `resolvePlanId` function.

- [x] `src/commands/ls.ts`
  - No performance concerns.

- [x] `src/commands/ps.ts`
  - No performance concerns.

- [x] `src/commands/rm.ts`
  - `resolvePlanId` called per ID, each doing full `listSessions` scan.

- [x] `src/commands/session.ts`
  - Same `readText` for tail mode issue. Duplicated `resolvePlanId`.

- [x] `src/commands/status.ts`
  - Sequential independent async operations that could be parallelized.

- [x] `src/commands/themes.ts`
  - No performance concerns.

- [x] `src/commands/update.ts`
  - `Bun.gunzipSync` blocks event loop during decompression of large binary.

- [x] `src/commands/version.ts`
  - No performance concerns.

- [x] `src/commands/clean.ts`
  - Session list scanned twice (once in clean, once in rm handler).

- [x] `src/cli.tsx`
  - **All command modules + `start.tsx` dependency chain eagerly imported at startup.** `synth version` pays same cost as `synth start`.

---

## Config

- [x] `src/config/loader.ts`
  - **Two sequential TOML reads (should be `Promise.all`).** No caching — `loadConfig` called many times per session.

- [x] `src/config/defaults.ts`
  - No performance concerns.

- [x] `src/config/paths.ts`
  - No performance concerns.

- [x] `src/config/types.ts`
  - No performance concerns.

- [x] `src/config/writer.ts`
  - `readTomlFile` does `fileExists` then `readText` — two FS ops where one suffices.

---

## Agents

- [x] `src/agents/base.ts`
  - **Synchronous `mkdirSync` on every `execute()` call.** Blocks event loop.

- [x] `src/agents/claude.ts`
  - **🔴 O(n²) string buffer pattern in `handleChunk`:** `this.buffer += chunk` followed by repeated `this.buffer.slice()` in a while loop. For large streaming responses, this is quadratic.

- [x] `src/agents/codex.ts`
  - Same O(n²) string buffer pattern.

- [x] `src/agents/registry.ts`
  - `getAgent()` creates new adapter instance on every call — no caching.

- [x] `src/agents/types.ts`
  - No performance concerns.

---

## Prompts + Templates

- [x] `src/prompts/build.ts`
  - `extractCodebasePatterns` regex with lazy quantifier + lookahead could backtrack on large inputs.

- [x] `src/prompts/instructions.ts`
  - Top-level `Handlebars.compile()` runs synchronously at import time.

- [x] `src/templates/builtin.ts`
  - No performance concerns.

- [x] `src/templates/engine.ts`
  - Template cache keyed by full template string (hashing multi-KB strings on every lookup).

- [x] `src/templates/index.ts`
  - No performance concerns.

- [x] `src/templates/types.ts`
  - No performance concerns.

---

## Tasks

- [x] `src/tasks/planner.ts`
  - Multiple regex attempts on large agent output. Greedy fallback regex.

- [x] `src/tasks/selector.ts`
  - No performance concerns.

- [x] `src/tasks/store.ts`
  - Non-atomic read-modify-write in `persistTaskStatus`.
  - `getProgress` iterates tasks 4 times (should be single pass).

- [x] `src/tasks/types.ts`
  - No performance concerns.

---

## Sessions

- [x] `src/sessions/id.ts`
  - No performance concerns.

- [x] `src/sessions/registry.ts`
  - **`getRepoKey` spawns a git subprocess on every call.** Not cached. Called by every session operation.
  - `listSessions` does sequential async I/O per directory entry. Could use `Promise.all`.
  - `getMostRecentSession` loads ALL session metadata just to get most recent.

- [x] `src/sessions/slug.ts`
  - No performance concerns.

- [x] `src/sessions/types.ts`
  - No performance concerns.

---

## Logging

- [x] `src/logging/engine-bridge.ts`
  - No performance concerns.

- [x] `src/logging/logger.ts`
  - **`normalizeObject` double-serializes:** `JSON.stringify` then `JSON.parse` on every log call with metadata.
  - `safeStringify` with WeakSet circular ref detector runs on every log entry.
  - Write chain serialization creates long promise chain under high log volume.

- [x] `src/logging/reader.ts`
  - `processChunk` allocates `Buffer.alloc(8192)` on every watcher callback with no debounce.

- [x] `src/logging/types.ts`
  - No performance concerns.

---

## Utils

- [x] `src/utils/perf.ts`
  - No performance concerns. All guarded by `enabled` flag.

- [x] `src/utils/format.ts`
  - No performance concerns.

- [x] `src/utils/fs.ts`
  - `ensureDir` called on every `writeJson`/`writeText`/`appendText` — unnecessary `mkdir` syscall when dir already exists.

- [x] `src/utils/git.ts`
  - Every function spawns a subprocess. No result caching.

- [x] `src/utils/process.ts`
  - `{ ...process.env, ...env }` spreads entire process environment on every spawn call.

- [x] `src/utils/text.ts`
  - No performance concerns.

- [x] `src/utils/tool-format.ts`
  - No performance concerns.

- [x] `src/utils/clipboard.ts`
  - No performance concerns.

- [x] `src/utils/editor.ts`
  - No performance concerns.

- [x] `src/notifications.ts`
  - No performance concerns.

---

## Interview + Conversation

- [x] `src/interview/interviewer.ts`
  - Up to 3 agent round-trips per `respond()`. By design.

- [x] `src/interview/types.ts`
  - No performance concerns.

- [x] `src/conversation/engine.ts`
  - `buildPrompt` reconstructs entire conversation history string on every `send()`.
  - `getHistory()` shallow-copies messages array on every call.

- [x] `src/conversation/index.ts`
  - No performance concerns.

- [x] `src/conversation/types.ts`
  - No performance concerns.

---

## Doctor

- [x] `src/doctor/doctor.ts`
  - All checks run sequentially. Many are independent and could parallelize.

- [x] `src/doctor/types.ts`
  - No performance concerns.

---

## Platform

- [x] `src/platform/darwin.ts`
  - `getAvailableDiskMb` uses synchronous `execSync`. Blocks event loop.

- [x] `src/platform/default.ts`
  - No performance concerns.

- [x] `src/platform/index.ts`
  - No performance concerns.

- [x] `src/platform/linux.ts`
  - **`commandExists` calls `spawnSync` TWICE for the same command** (bug). Doubles cost.
  - Multiple synchronous subprocess spawns block event loop.

- [x] `src/platform/types.ts`
  - No performance concerns.

---

## Finalize

- [x] `src/finalize/finalize.ts`
  - `sessionPaths.prd` read twice — should reuse loaded content.
  - Sequential subprocess spawning for git operations.

- [x] `src/finalize/audit.ts`
  - Per-tool-event allocations in `onTool` callback.
  - Greedy regex fallback `[\s\S]*` can be expensive on large outputs.

- [x] `src/finalize/audit-chat.ts`
  - `buildAuditSystemPrompt` builds large constant string every call — should be module-level.

- [x] `src/finalize/chat-types.ts`
  - No performance concerns.

- [x] `src/finalize/formatter.ts`
  - Sequential `fileExists` checks for formatter detection — could parallelize.
  - Dead code: loop always breaks after first formatter.

- [x] `src/finalize/orchestrator.ts`
  - `getMessages()` returns `[...this.messages]` — shallow copy on every call.
  - `parseAIResponse` runs 6 sequential regex replacements, each creating intermediate string.

- [x] `src/finalize/parallel-bridge.ts`
  - **`buildWorkerInfos` runs on every parallel event.** Creates new array with `.map()` each time.
  - Repeated `.filter(w => w.status === "running").length` on every event.
  - Linear scans in `applyParallelEvent` — should use Map.

- [x] `src/finalize/pr.ts`
  - `ERROR_PATTERNS` evaluates `getPlatform().installHint("gh")` at import time — side effect.

- [x] `src/finalize/review.ts`
  - Per-tool-event allocation. Greedy regex fallback.

- [x] `src/finalize/splitter.ts`
  - No major concerns. `categorizeFile` O(files × patterns) is acceptable.

- [x] `src/finalize/fix-converter.ts`
  - No performance concerns.

---

## Parallel

- [x] `src/parallel/coordinator.ts`
  - `buildMergedTaskSummaries` rebuilds taskMap from scratch on every call.
  - `timestamp()` creates `new Date().toISOString()` on every event emission.
  - `persistState` converts Map entries to array on every call.

- [x] `src/parallel/events.ts`
  - No performance concerns.

- [x] `src/parallel/index.ts`
  - No performance concerns.

- [x] `src/parallel/merge-engine.ts`
  - `processNext` uses linear scan `this.operations.find()`. Should use queue.
  - Backup tags never cleaned up — accumulate over many merges.

- [x] `src/parallel/resource-monitor.ts`
  - `cpus()` called on every `snapshot()` (2-second interval). Should cache briefly.

- [x] `src/parallel/session.ts`
  - Very I/O heavy cleanup: all sequential where much could parallelize.

- [x] `src/parallel/task-graph.ts`
  - O(n²) cycle detection: `sorted.includes(id)`. Should use Set.
  - O(n²) file overlap check in `recommendParallelism`.

- [x] `src/parallel/worker.ts`
  - `getDisplayState()` creates new object on every call — hot-path during parallel execution.
  - `stripAnsi(event.message)` + `.trim().slice(-200)` per stdout line.

- [x] `src/parallel/worktree-manager.ts`
  - Sequential worktree cleanup. `git worktree prune` called after every individual removal instead of once.

- [x] `src/parallel/ai-resolver.ts`
  - No performance concerns.

- [x] `src/parallel/conflict-resolver.ts`
  - **Synchronous `writeFileSync`/`unlinkSync` block event loop.**
  - Sequential conflict resolution — could parallelize with concurrency limit.

---

## Review

- [x] `src/review/orchestrator.ts`
  - Sequential file reads for independent data. Could parallelize.

- [x] `src/review/resume-route.ts`
  - No performance concerns.

- [x] `src/review/reviewer.ts`
  - No performance concerns.

- [x] `src/review/types.ts`
  - No performance concerns.

---

## Themes

- [x] `src/tui/themes/registry.ts`
  - All 7 theme objects loaded at import time regardless of which is selected.
  - `discoverCustomThemes()` hits filesystem on every call — no caching.

- [x] `src/tui/themes/resolve.ts`
  - Redundant dynamic import for `defaultSpinner`.

- [x] `src/tui/themes/catppuccin.ts` — No concerns.
- [x] `src/tui/themes/dracula.ts` — No concerns.
- [x] `src/tui/themes/gruvbox.ts` — No concerns.
- [x] `src/tui/themes/nord.ts` — No concerns.
- [x] `src/tui/themes/onedark.ts` — No concerns.
- [x] `src/tui/themes/solarized.ts` — No concerns.
- [x] `src/tui/themes/tokyonight.ts` — No concerns.

---

# Top 10 Root Causes of TUI Sluggishness During Streaming

Ranked by impact on the streaming hot path:

## 1. O(n²) string buffer in agent parsers (`claude.ts`, `codex.ts`)
`this.buffer += chunk` then `this.buffer.slice(0, newlineIdx)` / `this.buffer.slice(newlineIdx + 1)` in a while loop. For a 100KB streaming response, the total work is proportional to n². This is the NDJSON parsing layer — every byte from the LLM goes through this.

## 2. Per-chunk string concatenation + 100KB slice (`tui-adapter.ts`)
`this.tuiData.output += stripped` then `this.tuiData.output.slice(-MAX_OUTPUT_LENGTH)`. After the 100KB limit is hit, every single chunk allocates a ~100KB string just to trim it. This runs on every `agent:stdout` event.

## 3. Per-chunk regex allocations (`ac-done.ts`, `engine.ts`)
Three regex operations run on EVERY streaming chunk: `parseAcDoneMarkers` (allocates new RegExp), `stripAcDoneMarkers` (allocates new regex), and `COMPLETION_PATTERN.replace`. These are unnecessary during 99.9% of streaming — the markers only appear once at the end.

## 4. Spinner 80ms timer cascade (Spinner → PhaseIndicator → OutputPane)
`Spinner.tsx` is not `memo()`'d and fires 12.5 times/second. It cascades through non-memoized `PhaseIndicator` → `AgentStreamingBubble` → `AgentStreamingBody`. This creates constant re-renders independent of actual data changes.

## 5. ExecutionView 1-second forced full re-render
`setInterval` every 1000ms with zero memoization. Every tick re-runs `tasks.filter()`, `displayOutput.slice(-256)`, and passes new object references to all children.

## 6. `appendTaskOutput` O(n) per chunk (`task-state.ts`)
`prev + chunk` creates intermediate string, then `.slice(-maxLength)` creates another. Called on every stdout chunk.

## 7. Un-throttled renderSerial() for non-streaming events (`tui-adapter.ts`)
Only `agent:stdout` and `agent:tool` use the 80ms throttle. All other events (`phase:*`, `task:start`, `task:complete`, `state:change`, `iteration:end`, `agent:stderr`) call `renderSerial()` directly, triggering immediate React reconciliation.

## 8. `isTypableChar` Set allocation per keypress (`ParallelBridge.tsx`)
`new Set(["a", "b", "c", ...])` with 30+ entries created inside the function body on every keypress.

## 9. Inline style objects everywhere (OutputPane, Header, StatusBar, etc.)
New object literals like `style={{ backgroundColor: colors.bg.secondary }}` on every render of hot-path components. Breaks referential equality, defeating React's shallow comparison.

## 10. No memoization on derived data in view components
`tasks.filter()`, `displayOutput.slice()`, layout math — all recomputed on every render (1s tick + data changes) with no `useMemo`.
