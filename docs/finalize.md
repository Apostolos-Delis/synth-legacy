# Finalize Pipeline

The finalize pipeline (`src/finalize/`) runs after all tasks are complete. It reviews the changes, formats code, splits commits by category, and creates a pull request — turning a batch of agent-written changes into a clean, reviewable PR.

## Pipeline Overview

```
synth finalize [<plan-id>]
  |
  v
1. Self-Review ──> findings[] ──> critical? -> BLOCKED
  |
  v
2. Auto-Format ──> detect formatter -> run -> commit
  |
  v
3. Split Commits ──> categorize files -> separate commits
  |
  v
4. Create PR ──> generate body -> git push -> gh pr create
  |
  v
FinalizeResult { findings, formatted, commitCount, prUrl, blocked }
```

### Pipeline Result

```typescript
interface FinalizeResult {
  findings: ReviewFinding[];
  formatted: boolean;
  commitCount: number;
  prUrl: string | null;
  blocked: boolean;
  blockReason?: string;
}
```

Each stage is controlled by `[finalize]` config flags and can be individually disabled.

## Stage 1: Self-Review

**Config**: `finalize.self_review` (default: `true`)

The review stage (`src/finalize/review.ts`) sends the full diff to an AI agent for review from three perspectives:

| Perspective | Focus Areas |
|-------------|-------------|
| `developer` | Code structure, performance, conventions, readability |
| `security` | Secrets, input validation, OWASP top 10, injection vectors |
| `testing` | Test coverage, edge cases, missing assertions |

### Review Findings

```typescript
interface ReviewFinding {
  perspective: "developer" | "security" | "testing";
  severity: "critical" | "warning" | "info";
  message: string;
}
```

The diff sent to the agent is `git diff <base_branch>...HEAD`, truncated to 50,000 characters to fit within context limits. The agent returns findings as a JSON array.

### Blocking Behavior

If any finding has `severity: "critical"`, the pipeline is **blocked** — no formatting, splitting, or PR creation happens. The critical findings are reported so the user can address them before re-running `synth finalize`.

## Stage 2: Auto-Format

**Config**: `finalize.auto_format` (default: `true`)

The formatter (`src/finalize/formatter.ts`) detects and runs the project's configured formatter. Detection is based on config file presence:

| Config File | Formatter | Command |
|-------------|-----------|---------|
| `.prettierrc` | Prettier | `npx prettier --write .` |
| `.prettierrc.json` | Prettier | `npx prettier --write .` |
| `biome.json` | Biome | `npx @biomejs/biome format --write .` |
| `pyproject.toml` | Black | `black .` |
| `.rubocop.yml` | RuboCop | `rubocop -a` |
| `package.json` (with `scripts.format`) | npm format | `npm run format` |

Only the **first matching** formatter is run. If formatting produces changes, they're committed as:

```
style: auto-format
```

## Stage 3: Split Commits

**Config**: `finalize.split_commits` (default: `true`)

The splitter (`src/finalize/splitter.ts`) categorizes changed files and creates separate commits for each category, producing a clean git history.

### File Categorization

| File Pattern | Commit Prefix |
|-------------|--------------|
| `\.(test\|spec)\.(ts\|tsx\|js\|jsx)$` | `test` |
| `\.(md\|txt\|rst)$` | `docs` |
| `\.(css\|scss\|less\|styled)` | `style` |
| `(config\|\.config\|tsconfig\|eslint\|prettier)` | `chore` |
| `migration` | `refactor` |
| Everything else | `feat` |

### Process

1. `git reset HEAD` — Unstage everything
2. For each category group:
   - `git add <file1> <file2> ...`
   - `git commit -m "<prefix>: <description>"`

This produces commits like:
```
feat: implement user authentication
test: add auth test coverage
docs: update API documentation
chore: configure eslint rules
```

## Stage 4: Create PR

**Config**: `finalize.create_pr` (default: `true`)

The PR stage (`src/finalize/pr.ts`) generates a structured PR body and creates the pull request via the GitHub CLI.

### PR Body Structure

The generated PR body includes:

- **Context** — From the task description and PRD problem statement
- **Changes** — List of completed tasks with their titles
- **Test Plan** — Verification commands from tasks
- **Review Notes** — Warning-level findings from the self-review
- **Mitigation** — Diff stats (files changed, insertions, deletions)
- **Checklist** — Standard review checklist items

### Commands

```bash
# Push the branch
git push --set-upstream origin <branch>

# Create the PR
gh pr create --title "<title>" --body "<body>" --base <base_branch>
```

The `gh` CLI must be installed and authenticated for PR creation to work. If `gh` is not available, the pipeline completes without creating a PR and reports the issue.

## Configuration

All finalize options under `[finalize]` in `synth.toml`:

```toml
[finalize]
auto_format = true      # Run detected code formatters
split_commits = true    # Split changes into categorized commits
self_review = true      # AI-powered code review before PR
create_pr = true        # Create GitHub PR via gh CLI
pr_template = ""        # Optional: path to PR template file
```

Each stage can be toggled independently. For example, to skip the review and just format + PR:

```toml
[finalize]
self_review = false
auto_format = true
split_commits = true
create_pr = true
```
