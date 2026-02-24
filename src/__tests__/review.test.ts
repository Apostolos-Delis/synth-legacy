import { describe, test, expect } from "bun:test";
import { Reviewer } from "../review/reviewer.js";
import type { ReviewFinding } from "../review/types.js";
import type { AgentAdapter } from "../agents/types.js";

// Minimal mock agent — extractFindings/convertToTasks don't use the engine
const stubAgent = {
  name: "stub",
  send: async () => "",
  buildMessages: () => [],
} as unknown as AgentAdapter;

function makeReviewer(): Reviewer {
  return new Reviewer(stubAgent, "/tmp");
}

// ── extractFindings ──────────────────────────────────────────────────

describe("extractFindings", () => {
  test("parses single valid finding from markdown response", () => {
    const response = `
### [CRITICAL] Missing input validation
**File**: \`src/api/handler.ts\`
**Lines**: 42-50
**Description**: User input is passed directly to query without sanitization
**Suggestion**: Add zod schema validation before processing
`;
    const reviewer = makeReviewer();
    const findings = reviewer.extractFindings(response);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].title).toContain("Missing input validation");
    expect(findings[0].file).toBe("src/api/handler.ts");
    expect(findings[0].lines).toBe("42-50");
    expect(findings[0].description).toBe(
      "User input is passed directly to query without sanitization",
    );
    expect(findings[0].suggestion).toBe(
      "Add zod schema validation before processing",
    );
  });

  test("parses multiple findings with different severities", () => {
    const response = `
### [CRITICAL] SQL injection risk
**File**: \`src/db.ts\`
**Description**: Raw SQL concatenation
**Suggestion**: Use parameterized queries

### [WARNING] Unbounded list fetch
**File**: \`src/routes/list.ts\`
**Lines**: 10-15
**Description**: No pagination on list endpoint
**Suggestion**: Add limit/offset parameters

### [INFO] Console.log left in code
**File**: \`src/utils.ts\`
**Description**: Debug logging still present
**Suggestion**: Remove or replace with structured logger
`;
    const reviewer = makeReviewer();
    const findings = reviewer.extractFindings(response);

    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe("critical");
    expect(findings[1].severity).toBe("warning");
    expect(findings[2].severity).toBe("info");
    expect(findings[0].title).toContain("SQL injection risk");
    expect(findings[1].title).toContain("Unbounded list fetch");
    expect(findings[2].title).toContain("Console.log left in code");
  });

  test("handles finding without optional Lines field", () => {
    const response = `
### [WARNING] Hardcoded secret
**File**: \`src/config.ts\`
**Description**: API key is hardcoded
**Suggestion**: Move to environment variable
`;
    const reviewer = makeReviewer();
    const findings = reviewer.extractFindings(response);

    expect(findings).toHaveLength(1);
    expect(findings[0].lines).toBeUndefined();
    expect(findings[0].file).toBe("src/config.ts");
  });

  test("severity matching is case-insensitive", () => {
    const response = `
### [critical] Lowercase severity
**File**: \`a.ts\`
**Description**: desc
**Suggestion**: fix

### [WARNING] Uppercase severity
**File**: \`b.ts\`
**Description**: desc
**Suggestion**: fix

### [Info] Mixed case severity
**File**: \`c.ts\`
**Description**: desc
**Suggestion**: fix
`;
    const reviewer = makeReviewer();
    const findings = reviewer.extractFindings(response);

    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe("critical");
    expect(findings[1].severity).toBe("warning");
    expect(findings[2].severity).toBe("info");
  });

  test("returns empty array for empty string", () => {
    const reviewer = makeReviewer();
    expect(reviewer.extractFindings("")).toEqual([]);
  });

  test("returns empty array for text with no findings", () => {
    const reviewer = makeReviewer();
    const response = "Everything looks good! No issues found.";
    expect(reviewer.extractFindings(response)).toEqual([]);
  });

  test("returns empty array for malformed markdown", () => {
    const reviewer = makeReviewer();
    const malformed = `
## Not a finding header
Some random text that doesn't match the pattern
### [UNKNOWN_SEVERITY] Not a valid severity
**File**: something
`;
    expect(reviewer.extractFindings(malformed)).toEqual([]);
  });

  test("handles response with extra content between findings", () => {
    const response = `
Here is my review:

### [CRITICAL] Issue one
**File**: \`src/a.ts\`
**Description**: First issue
**Suggestion**: Fix it

Some commentary between findings that should be ignored.

### [INFO] Issue two
**File**: \`src/b.ts\`
**Description**: Second issue
**Suggestion**: Also fix
`;
    const reviewer = makeReviewer();
    const findings = reviewer.extractFindings(response);

    expect(findings).toHaveLength(2);
    expect(findings[0].title).toContain("Issue one");
    expect(findings[1].title).toContain("Issue two");
  });
});

// ── convertToTasks ───────────────────────────────────────────────────

describe("convertToTasks", () => {
  test("generates TaskFile with RVW-prefixed IDs", () => {
    const findings: ReviewFinding[] = [
      {
        severity: "critical",
        title: "Missing auth check",
        file: "src/api.ts",
        lines: "10-20",
        description: "No auth middleware",
        suggestion: "Add authentication middleware",
      },
      {
        severity: "warning",
        title: "No error handling",
        file: "src/handler.ts",
        description: "Unhandled promise rejection",
        suggestion: "Wrap in try/catch",
      },
    ];

    const reviewer = makeReviewer();
    const taskFile = reviewer.convertToTasks(findings, "my-project", "feat/review");

    expect(taskFile.project).toBe("my-project");
    expect(taskFile.branchName).toBe("feat/review");
    expect(taskFile.description).toContain("Review findings");
    expect(taskFile.tasks).toHaveLength(2);

    expect(taskFile.tasks[0].id).toBe("RVW-001");
    expect(taskFile.tasks[1].id).toBe("RVW-002");
  });

  test("maps severity to correct priority", () => {
    const findings: ReviewFinding[] = [
      {
        severity: "critical",
        title: "Critical",
        file: "",
        description: "d",
        suggestion: "s",
      },
      {
        severity: "warning",
        title: "Warning",
        file: "",
        description: "d",
        suggestion: "s",
      },
      {
        severity: "info",
        title: "Info",
        file: "",
        description: "d",
        suggestion: "s",
      },
    ];

    const reviewer = makeReviewer();
    const taskFile = reviewer.convertToTasks(findings, "p", "b");

    expect(taskFile.tasks[0].priority).toBe(1); // critical
    expect(taskFile.tasks[1].priority).toBe(2); // warning
    expect(taskFile.tasks[2].priority).toBe(3); // info
  });

  test("task title includes severity and finding title", () => {
    const findings: ReviewFinding[] = [
      {
        severity: "warning",
        title: "Memory leak in cache",
        file: "src/cache.ts",
        description: "d",
        suggestion: "s",
      },
    ];

    const reviewer = makeReviewer();
    const taskFile = reviewer.convertToTasks(findings, "p", "b");

    expect(taskFile.tasks[0].title).toBe("[WARNING] Memory leak in cache");
  });

  test("task description includes file and lines when present", () => {
    const findings: ReviewFinding[] = [
      {
        severity: "critical",
        title: "Bug",
        file: "src/main.ts",
        lines: "5-10",
        description: "A bug",
        suggestion: "Fix the bug",
      },
    ];

    const reviewer = makeReviewer();
    const taskFile = reviewer.convertToTasks(findings, "p", "b");

    expect(taskFile.tasks[0].description).toContain("A bug");
    expect(taskFile.tasks[0].description).toContain("File: src/main.ts");
    expect(taskFile.tasks[0].description).toContain("Lines: 5-10");
  });

  test("task description omits file/lines when empty", () => {
    const findings: ReviewFinding[] = [
      {
        severity: "info",
        title: "General note",
        file: "",
        description: "Just a note",
        suggestion: "Consider this",
      },
    ];

    const reviewer = makeReviewer();
    const taskFile = reviewer.convertToTasks(findings, "p", "b");

    expect(taskFile.tasks[0].description).toBe("Just a note");
    expect(taskFile.tasks[0].description).not.toContain("File:");
  });

  test("suggestion becomes acceptance criteria", () => {
    const findings: ReviewFinding[] = [
      {
        severity: "warning",
        title: "Perf",
        file: "",
        description: "Slow",
        suggestion: "Use memoization",
      },
    ];

    const reviewer = makeReviewer();
    const taskFile = reviewer.convertToTasks(findings, "p", "b");

    expect(taskFile.tasks[0].acceptanceCriteria).toEqual(["Use memoization"]);
  });

  test("all tasks start as open with iterationCount 0", () => {
    const findings: ReviewFinding[] = [
      { severity: "critical", title: "A", file: "", description: "d", suggestion: "s" },
      { severity: "info", title: "B", file: "", description: "d", suggestion: "s" },
    ];

    const reviewer = makeReviewer();
    const taskFile = reviewer.convertToTasks(findings, "p", "b");

    for (const task of taskFile.tasks) {
      expect(task.status).toBe("open");
      expect(task.iterationCount).toBe(0);
    }
  });

  test("empty findings produce empty tasks array", () => {
    const reviewer = makeReviewer();
    const taskFile = reviewer.convertToTasks([], "my-proj", "main");

    expect(taskFile.project).toBe("my-proj");
    expect(taskFile.branchName).toBe("main");
    expect(taskFile.tasks).toEqual([]);
  });

  test("IDs are zero-padded to 3 digits", () => {
    const findings: ReviewFinding[] = Array.from({ length: 12 }, (_, i) => ({
      severity: "info" as const,
      title: `Finding ${i + 1}`,
      file: "",
      description: "d",
      suggestion: "s",
    }));

    const reviewer = makeReviewer();
    const taskFile = reviewer.convertToTasks(findings, "p", "b");

    expect(taskFile.tasks[0].id).toBe("RVW-001");
    expect(taskFile.tasks[8].id).toBe("RVW-009");
    expect(taskFile.tasks[9].id).toBe("RVW-010");
    expect(taskFile.tasks[11].id).toBe("RVW-012");
  });
});
