# PRD Interview System

The interview system (`src/interview/`) drives a multi-turn AI conversation to produce a structured PRD (Product Requirements Document) from a user's initial idea. This PRD then feeds into the task planner to generate actionable tasks.

## Overview

```
synth plan
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

### Starting the Interview

`Interviewer.start()` sends the system prompt to the agent and returns the opening question. The agent is instructed to interview the user across five topic areas before producing a PRD.

### Multi-Turn Conversation

Each call to `Interviewer.respond(userMessage)`:

1. Appends the user message to conversation history
2. Builds a prompt containing the system prompt + conversation history
3. Sends it to the agent
4. Appends the agent's response to history
5. Checks if the response contains a JSON PRD (extraction attempt)

### Sliding Window Context

To prevent context window overflow in long interviews, the interviewer uses a sliding window of the **last 16 messages** (8 user-agent turns). When messages are truncated, a note is prepended:

```
[Note: {N} earlier messages omitted for brevity]
```

This keeps the prompt size manageable while preserving the most recent and relevant context.

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

This markdown is written to `prd.md` in the plan directory and can be reviewed or edited before proceeding to task generation.

## Resuming an Existing Plan

When `synth plan --prd <path>` is used, the interview is skipped entirely. The provided PRD file is read directly and fed to the task planner. This supports:

- Pre-written PRDs from external tools
- Edited PRDs from previous interview sessions
- Re-generating tasks after manually modifying a PRD

## Task Generation Flow

After the PRD is finalized (either via interview or `--prd` flag):

1. PRD markdown is written to the plan directory
2. Plan status is updated to `planning`
3. `generateTasks(agent, prd, projectName, branchName, cwd)` sends the PRD to the agent with task generation instructions
4. The agent returns a JSON `TaskFile` with dependency-ordered tasks
5. Tasks are written to `tasks.json`
6. Plan status is updated to `executing`

See [tasks.md](tasks.md) for details on task generation, the `TaskFile` format, and dependency resolution.
