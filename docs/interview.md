# PRD Interview System

The interview system (`src/interview/`) drives a multi-turn AI conversation to produce a structured PRD (Product Requirements Document) from a user's initial idea. This PRD then feeds into the task planner to generate actionable tasks.

## Overview

```
synth start
  |
  v
Interviewer.start()
  |
  v
Agent asks opening question
  |
  v
User answers  <──────────────────┐
  |                               |
  v                               |
Interviewer.respond(message)      |
  |                               |
  v                               |
Agent asks next question ─────────┘
  |
  (agent signals PRD ready)
  |
  v
extractPrd(response) -> GeneratedPrd
  |
  v
prdToMarkdown(prd) -> prd.md
  |
  v
generateTasks(prd) -> tasks.json
```

## How It Works

### ConversationEngine

The interviewer delegates conversation management to a shared `ConversationEngine` (`src/conversation/engine.ts`). The engine handles message history, agent communication, sliding window truncation, and auto-persistence — the interviewer retains only PRD-specific logic (extraction, system prompt, confirmation flow).

### Starting the Interview

`Interviewer.start()` sends the system prompt to the agent via the ConversationEngine and returns the opening question. The agent is instructed to interview the user across five topic areas before producing a PRD.

### Multi-Turn Conversation

Each call to `Interviewer.respond(userMessage)`:

1. Delegates to `ConversationEngine.send(userMessage)` which:
   - Appends the user message to conversation history
   - Builds a prompt containing the system prompt + conversation history
   - Sends it to the agent (with optional streaming)
   - Appends the agent's response to history
   - Auto-persists conversation state to `interview.json`
2. Checks if the response contains a JSON PRD (extraction attempt)

### Auto-Persistence

Conversation state is automatically persisted to `interview.json` after every message exchange via the engine's `persist` callback. This means a crash or interruption at any point preserves all prior messages, enabling robust resume.

## System Prompt

Defined in `src/interview/prompts.ts`, the system prompt instructs the agent to:

1. **Explore the problem** — Ask about the problem statement, goals, and motivation
2. **Identify users** — Who will use this and how
3. **Define scope** — What's in and out of scope for this iteration
4. **Draft user stories** — Specific behaviors with acceptance criteria
5. **Set quality gates** — What automated checks should pass

### Style Guidelines

The prompt instructs the agent to:
- Ask focused, one-topic-at-a-time questions
- Push for specifics when answers are vague
- Summarize understanding before moving to the next topic
- Output the PRD as a fenced JSON block when enough information is gathered

## PRD Structure

```typescript
interface GeneratedPrd {
  title: string;
  problemStatement: string;
  goals: string[];
  targetUsers: string;
  scope: {
    included: string[];
    excluded: string[];
  };
  userStories: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
  }[];
  qualityGates: string[];
}
```

### Fields

| Field | Description |
|-------|-------------|
| `title` | Project/feature title |
| `problemStatement` | What problem this solves and why |
| `goals` | Measurable objectives |
| `targetUsers` | Who benefits from this |
| `scope.included` | What's in scope for this plan |
| `scope.excluded` | What's explicitly deferred |
| `userStories` | Concrete behaviors with IDs, descriptions, and acceptance criteria |
| `qualityGates` | Automated checks that must pass (e.g. "all tests pass", "no type errors") |

## PRD Extraction

`extractPrd(response)` attempts to parse a `GeneratedPrd` from the agent's response:

1. Look for a fenced JSON block (`` ```json ... ``` ``)
2. Parse the JSON
3. Validate it has the expected shape

If extraction fails, the conversation continues — the agent will try again in subsequent turns.

## PRD to Markdown

`prdToMarkdown(prd)` converts the structured PRD into a readable markdown document:

```markdown
# {title}

## Problem Statement
{problemStatement}

## Goals
- {goal1}
- {goal2}

## Target Users
{targetUsers}

## Scope

### Included
- {included1}
- {included2}

### Excluded
- {excluded1}

## User Stories

### US-001: {title}
{description}

**Acceptance Criteria:**
- {criteria1}
- {criteria2}

## Quality Gates
- {gate1}
- {gate2}
```

This markdown is written to `prd.md` in the session directory and can be reviewed or edited before proceeding to task generation.

## Resuming an Interview

`synth resume <session-id>` on a session in `interviewing` status restores the full conversation history from `interview.json` and resumes the interview in the TUI with all prior messages displayed. If no saved state exists (e.g., crashed before the first exchange), resume shows a clear error message.

## Skipping the Interview

When `synth start --prd <path>` is used, the interview is skipped entirely. The provided PRD file is read directly and fed to the task planner. This supports:

- Pre-written PRDs from external tools
- Edited PRDs from previous interview sessions
- Re-generating tasks after manually modifying a PRD

## Task Generation Flow

After the PRD is finalized (either via interview or `--prd` flag):

1. PRD markdown is written to the session directory
2. `generateTasks(agent, prd, projectName, branchName, cwd)` sends the PRD to the agent with task generation instructions
3. The agent returns a JSON `TaskFile` with dependency-ordered tasks
4. Tasks are written to `tasks.json`
5. Session status is updated to `planning`
6. User confirms tasks, then execution begins (status transitions to `executing`)

See [tasks.md](tasks.md) for details on task generation, the `TaskFile` format, and dependency resolution.
