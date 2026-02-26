# Synth Codebase Audit + Refactor for Modularity

## Problem Statement
The current codebase needs a focused audit and refactor to eliminate spaghetti code, enforce clear separation of concerns, and improve maintainability and scalability ahead of open-sourcing. Business logic must live in the core engine, with CLI orchestration and TUI rendering kept strictly separate. Platform-specific behaviors and agent differences must be isolated behind clean interfaces, with consistent logging and reliable prompt caching across the full session lifecycle.

## Goals
- Ensure no business logic exists in the TUI layer; TUI is view-only.
- Enforce clean modular boundaries: core engine, CLI orchestration, TUI rendering, platform interfaces, agent adapters.
- Eliminate duplication and unclear ownership; refactor to clear interfaces and single-responsibility modules.
- Achieve consistent, structured logging across all phases of a session.
- Maintain or improve performance for CLI/TUI startup and runtime.
- Enforce TypeScript best practices, including zero `any`.

## Target Users
Primary users are end users running the CLI/TUI and maintainers (current and external contributors) who need a clear, well-structured, easy-to-understand codebase.

## Scope
### Included
- Full audit of `src/` to identify spaghetti code, overlapping concerns, and weak modularity.
- Refactor to move business logic into core engine modules.
- Extract all OS-specific logic into platform interfaces and implementations.
- Ensure agent differences are isolated via adapter/translation layers.
- Remove duplicate logic and consolidate into clear interfaces.
- Implement consistent structured logging across session phases.
- Improve prompt caching behavior for correctness and reuse.

### Excluded
- New product features or user-facing functionality beyond refactor-driven changes.
- Backwards-compatibility shims or deprecated aliases.
- UI redesign or new TUI features unrelated to separation of concerns.
- Adding new agent providers beyond existing ones.

## Architecture & Technical Approach
- Define and enforce module boundaries: core engine contains all business logic; CLI orchestrates inputs/outputs; TUI only renders state and user interactions; platform module encapsulates OS-specific behavior; agent adapter layer normalizes provider differences.
- Use strict TypeScript typing with zero `any`.
- Replace implicit coupling with explicit interfaces (inputs/outputs, lifecycle events).
- Centralize logging with structured, consistent fields (level, session id, phase, component).
- Ensure prompt caching is centralized and consumed by the core engine, not UI layers.

## Edge Cases & Error Handling
- Headless runs: core engine must operate fully without the TUI; CLI can run alone.
- OS feature failures (e.g., sleep-prevention): surface as non-fatal warnings with fallbacks.
- Missing/invalid agent credentials: fail fast with clear errors and log context.
- Empty or malformed user inputs: validate early and return actionable errors.
- Concurrent or overlapping sessions: ensure state isolation and unique session ids in logs.

## Dependencies
- Existing Bun and TypeScript toolchain.
- Existing TUI framework and logging utilities in the repo.
- Existing agent SDKs/adapters currently in use.

## Testing Strategy
- Unit tests for platform interfaces and agent adapters.
- Integration tests for CLI invoking core engine without TUI.
- Integration tests for TUI rendering with mocked core state.
- Typecheck and lint as part of CI.
- Manual verification: run representative CLI and TUI flows and verify logs.

## User Stories
### US-001: Maintainable Modular Architecture
As a maintainer, I want clear module boundaries so the codebase is easy to understand and change.
**Acceptance Criteria:**
- [ ] All business logic resides in core engine modules; no business logic exists in TUI files.
- [ ] OS-specific behaviors are only implemented in platform modules and invoked via platform interfaces.
- [ ] Agent-specific logic is only present in adapter/translation layers.
- [ ] No TypeScript `any` types remain in the codebase.

### US-002: Consistent Logging
As a maintainer, I want consistent logs across the entire session so debugging is straightforward.
**Acceptance Criteria:**
- [ ] Logs are emitted for startup, configuration load, agent selection, session run, completion, and error paths.
- [ ] Each log entry includes `level`, `sessionId`, `phase`, and `component`.
- [ ] Errors include contextual metadata for root cause identification.

### US-003: CLI/TUI Separation
As an end user, I want the CLI to function independently of the TUI so headless usage is reliable.
**Acceptance Criteria:**
- [ ] CLI can execute a full session without importing or invoking TUI modules.
- [ ] TUI receives only state/events from the core engine and does not perform business logic.
- [ ] Removing TUI entrypoints does not break CLI execution.

### US-004: Prompt Caching Correctness
As a maintainer, I want prompt caching centralized so it is reliable and reusable.
**Acceptance Criteria:**
- [ ] Prompt cache reads/writes occur only in core engine modules.
- [ ] Cache keys and invalidation rules are documented in code and tests verify behavior.
- [ ] Cache usage is logged with hit/miss metrics per session.

### US-005: Performance Preservation
As an end user, I want the TUI/CLI to remain responsive after refactors.
**Acceptance Criteria:**
- [ ] Baseline and post-refactor startup times are measured and reported.
- [ ] No more than 10% regression in startup time for CLI or TUI compared to baseline.

## Quality Gates
- All acceptance criteria pass.
- Typecheck and lint pass with zero `any`.
- No business logic in TUI; verified via code audit.
- Integration tests validate CLI-only execution and TUI rendering.

If this looks right, I can proceed with the audit and refactor plan. If you want to add constraints (performance targets, specific modules to prioritize, logging format), tell me what to change.