# Structured JSONL Logging Across Codebase

## Problem Statement
The current logging is unstructured and not queryable, making debugging and analysis inefficient. We need consistent, structured JSONL logs across the entire codebase so developers can reliably filter, search, and correlate events.

## Goals
- Produce queryable JSONL logs for all diagnostic logging across the codebase.
- Standardize log fields so developers can reliably filter and correlate events.
- Preserve existing user-facing output while migrating diagnostic logs to structured logging.

## Target Users
Developers who read logs for debugging and diagnosing issues.

## Scope
### Included
- Replace all diagnostic logging across the codebase with structured JSONL output.
- Define and enforce a consistent log schema with required and optional fields.
- Add contextual fields (request/operation identifiers) where available.

### Excluded
- Log aggregation setup (e.g., ELK, Datadog, Splunk).
- Dashboards, alerts, or query UI.
- Changes to user-facing CLI output that is not diagnostic logging.

## Architecture & Technical Approach
- Implement or adapt a centralized logger per language to emit JSONL (one JSON object per line).
- Standardize a shared schema across languages:
  - Required: `timestamp` (ISO 8601), `level`, `message`, `service`, `env`
  - Optional when available: `request_id`, `trace_id`, `user_id`, `job_id`, `command`, `duration_ms`, `error`
- All diagnostic logs must go through the structured logger; no unstructured output for diagnostics.
- Output logs to stdout/stderr as appropriate for existing log collection.

## Edge Cases & Error Handling
- Non-serializable fields (e.g., circular refs) are safely stringified or omitted without crashing the app.
- Missing context fields are omitted or set to `null` consistently.
- Very large payloads are truncated or summarized to avoid excessive log volume.
- Logging failures never crash the process; they degrade to a minimal safe JSON log.

## Dependencies
- No new external services required.
- If a minimal JSON logging formatter/library is needed per language, add the smallest stable dependency.

## Testing Strategy
- Unit tests for log formatting and schema enforcement.
- Integration tests that run a representative operation and assert valid JSONL output with required fields.
- Manual verification of one end-to-end run to ensure logs are queryable and readable.

## User Stories
### US-001: Consistent JSONL Logs
As a developer, I want all diagnostic logs to be structured JSONL so I can query and filter them reliably.
**Acceptance Criteria:**
- [ ] Every diagnostic log line is valid JSON (one object per line).
- [ ] Each log entry includes `timestamp`, `level`, `message`, `service`, and `env`.
- [ ] No diagnostic logs are emitted in unstructured formats.

### US-002: Contextual Correlation
As a developer, I want logs to include operation context so I can trace related events.
**Acceptance Criteria:**
- [ ] When a request/operation context exists, logs include the relevant ID fields (e.g., `request_id`, `trace_id`, `job_id`).
- [ ] Context fields are omitted or `null` when not available, with consistent behavior across languages.

### US-003: Robust Error Logging
As a developer, I want errors logged with structured details to speed up debugging.
**Acceptance Criteria:**
- [ ] Error logs include a structured `error` object with `type` and `message`.
- [ ] Stack/backtrace is included in `error.stack` (or language equivalent) when available.
- [ ] Logging an error never throws or crashes the application.

## Quality Gates
- All existing tests and linters pass.
- A sample run produces only JSONL diagnostic logs, with no unstructured diagnostic output.