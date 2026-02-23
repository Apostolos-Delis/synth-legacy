import { describe, test, expect } from "bun:test";
import { prdToMarkdown } from "../interview/interviewer.js";
import { generateTasks } from "../tasks/planner.js";
import type { GeneratedPrd } from "../interview/types.js";
import { withTmpDir, makeSessionPaths } from "./helpers.js";
import { writeText } from "../utils/fs.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFullPrd(overrides?: Partial<GeneratedPrd>): GeneratedPrd {
  return {
    title: "Auth System",
    problemStatement: "Users cannot log in.",
    goals: ["Implement login", "Add password reset"],
    targetUsers: "All registered users",
    scope: {
      included: ["Login page", "Password reset flow"],
      excluded: ["Social auth", "MFA"],
    },
    userStories: [
      {
        id: "US-001",
        title: "User Login",
        description: "As a user I can log in with email and password.",
        acceptanceCriteria: ["Email field validates format", "Wrong password shows error"],
      },
    ],
    qualityGates: ["All tests pass", "No lint errors"],
    ...overrides,
  };
}

function makeEmptyPrd(): GeneratedPrd {
  return {
    title: "",
    problemStatement: "",
    goals: [],
    targetUsers: "",
    scope: { included: [], excluded: [] },
    userStories: [],
    qualityGates: [],
  };
}

function makeMockAgent(stdout = "{}") {
  return {
    execute: (_prompt: string, opts?: Record<string, unknown>) => {
      const onStdout = opts?.onStdout as ((chunk: string) => void) | undefined;
      const handle = {
        promise: Promise.resolve().then(() => {
          onStdout?.(stdout);
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
        interrupt: () => {},
        pid: 0,
        process: null as unknown,
      };
      return handle;
    },
  } as unknown as import("../agents/types.js").AgentAdapter;
}

// ---------------------------------------------------------------------------
// 1. PRD markdown is displayed after review completion
// ---------------------------------------------------------------------------

describe("prdToMarkdown — PRD markdown rendering", () => {
  test("renders full PRD as markdown with all sections", () => {
    const prd = makeFullPrd();
    const md = prdToMarkdown(prd);

    expect(md).toContain("# Auth System");
    expect(md).toContain("## Problem Statement");
    expect(md).toContain("Users cannot log in.");
    expect(md).toContain("## Goals");
    expect(md).toContain("- Implement login");
    expect(md).toContain("- Add password reset");
    expect(md).toContain("## Target Users");
    expect(md).toContain("All registered users");
    expect(md).toContain("## Scope");
    expect(md).toContain("### Included");
    expect(md).toContain("- Login page");
    expect(md).toContain("### Excluded");
    expect(md).toContain("- Social auth");
    expect(md).toContain("## User Stories");
    expect(md).toContain("### US-001: User Login");
    expect(md).toContain("As a user I can log in with email and password.");
    expect(md).toContain("**Acceptance Criteria:**");
    expect(md).toContain("- [ ] Email field validates format");
    expect(md).toContain("## Quality Gates");
    expect(md).toContain("- All tests pass");
  });

  test("output is markdown, not JSON", () => {
    const prd = makeFullPrd();
    const md = prdToMarkdown(prd);

    // Must start with markdown heading, not JSON brace
    expect(md.trimStart().startsWith("#")).toBe(true);
    // Should not be parseable as JSON
    expect(() => JSON.parse(md)).toThrow();
  });

  test("handles empty PRD without crashing", () => {
    const prd = makeEmptyPrd();
    const md = prdToMarkdown(prd);

    expect(typeof md).toBe("string");
    expect(md).toContain("# ");
    expect(md).toContain("## Problem Statement");
    expect(md).toContain("## Goals");
    expect(md).toContain("## User Stories");
  });

  test("renders multiple user stories", () => {
    const prd = makeFullPrd({
      userStories: [
        { id: "US-001", title: "Login", description: "Login flow", acceptanceCriteria: ["AC1"] },
        { id: "US-002", title: "Register", description: "Registration flow", acceptanceCriteria: ["AC2", "AC3"] },
        { id: "US-003", title: "Logout", description: "Logout flow", acceptanceCriteria: [] },
      ],
    });
    const md = prdToMarkdown(prd);

    expect(md).toContain("### US-001: Login");
    expect(md).toContain("### US-002: Register");
    expect(md).toContain("### US-003: Logout");
    expect(md).toContain("- [ ] AC1");
    expect(md).toContain("- [ ] AC2");
    expect(md).toContain("- [ ] AC3");
  });

  test("handles PRD with special markdown characters in fields", () => {
    const prd = makeFullPrd({
      title: "Feature: `code` & **bold** text",
      problemStatement: "Users see `500` errors when calling `/api/data`.",
      goals: ["Support `JSON` parsing", "Handle > 1000 items"],
    });
    const md = prdToMarkdown(prd);

    expect(md).toContain("# Feature: `code` & **bold** text");
    expect(md).toContain("`500`");
    expect(md).toContain("`/api/data`");
    expect(md).toContain("- Support `JSON` parsing");
    expect(md).toContain("- Handle > 1000 items");
  });
});

// ---------------------------------------------------------------------------
// 2. Tasks JSON is not shown during review phase
// ---------------------------------------------------------------------------

describe("review phase shows PRD markdown, not tasks JSON", () => {
  test("prdToMarkdown output does not contain JSON task structures", () => {
    const prd = makeFullPrd();
    const md = prdToMarkdown(prd);

    // The markdown should not contain JSON task array structures
    expect(md).not.toContain('"tasks"');
    expect(md).not.toContain('"status": "open"');
    expect(md).not.toContain('"iterationCount"');
    expect(md).not.toContain('"dependsOn"');
    expect(md).not.toContain('"branchName"');
  });

  test("prdToMarkdown output is distinct from task file JSON format", () => {
    const prd = makeFullPrd();
    const md = prdToMarkdown(prd);

    // TaskFile format has specific keys: project, branchName, description, tasks[]
    // PRD markdown should contain headings and bullet points, not JSON keys
    expect(md).toMatch(/^#\s/m); // has markdown headings
    expect(md).toMatch(/^- /m); // has markdown list items
    expect(md).not.toMatch(/^\s*\{/m); // no JSON object start
    expect(md).not.toMatch(/^\s*\[/m); // no JSON array start
  });

  test("PRD content passed to review is markdown string, not serialized tasks", () => {
    // Simulate the pipeline: PRD object → prdToMarkdown → string used for review
    const prd = makeFullPrd();
    const reviewContent = prdToMarkdown(prd);

    // The string passed to PrdReviewView.prdMarkdown should be renderable markdown
    expect(typeof reviewContent).toBe("string");
    expect(reviewContent.length).toBeGreaterThan(0);
    // Contains section headers that a markdown renderer would format
    const headings = reviewContent.match(/^#{1,3}\s.+$/gm) || [];
    expect(headings.length).toBeGreaterThanOrEqual(6); // title, problem, goals, target, scope, user stories, quality
  });
});

// ---------------------------------------------------------------------------
// 3. generateTasks is not called before PRD is finalized and displayed
// ---------------------------------------------------------------------------

describe("pipeline ordering — generateTasks requires finalized PRD", () => {
  test("generateTasks throws when PRD file does not exist", async () => {
    const agent = makeMockAgent();

    await expect(
      generateTasks(agent, "/nonexistent/path/prd.md", "test", "main", "/tmp", { taskPrefix: "AUTH" }),
    ).rejects.toThrow("PRD file not found");
  });

  test("generateTasks throws with descriptive message mentioning the missing path", async () => {
    const agent = makeMockAgent();
    const missingPath = "/tmp/synth-fake-12345/prd.md";

    await expect(
      generateTasks(agent, missingPath, "test", "main", "/tmp", { taskPrefix: "AUTH" }),
    ).rejects.toThrow(missingPath);
  });

  test("generateTasks succeeds when PRD file exists on disk", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const prdContent = "# Test PRD\n\nThis is a test PRD.";
      await writeText(paths.prd, prdContent);

      const validTaskJson = JSON.stringify({
        project: "test",
        branchName: "main",
        description: "test tasks",
        tasks: [{ id: "US-001", title: "First task", description: "desc", acceptanceCriteria: [], priority: 1, status: "open", iterationCount: 0 }],
      });

      const agent = makeMockAgent(validTaskJson);
      const result = await generateTasks(agent, paths.prd, "test", "main", dir);

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe("US-001");
    });
  });

  test("pipeline: writing PRD to disk then calling generateTasks works end-to-end", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);

      // Step 1: generateTasks must fail before PRD is written
      const agent = makeMockAgent();
      await expect(
        generateTasks(agent, paths.prd, "test", "main", dir),
      ).rejects.toThrow("PRD file not found");

      // Step 2: Write finalized PRD to disk (simulating the pipeline)
      const prd = makeFullPrd();
      const markdown = prdToMarkdown(prd);
      await writeText(paths.prd, markdown);

      // Step 3: Now generateTasks should succeed
      const validTaskJson = JSON.stringify({
        project: "test",
        branchName: "main",
        description: "generated",
        tasks: [{ id: "US-001", title: "Task", description: "d", acceptanceCriteria: [], priority: 1, status: "open", iterationCount: 0 }],
      });
      const agent2 = makeMockAgent(validTaskJson);
      const result = await generateTasks(agent2, paths.prd, "test", "main", dir);

      expect(result.tasks).toHaveLength(1);
    });
  });

  test("generateTasks reads the PRD content and includes it in the agent prompt", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const prdContent = "# My Special PRD\n\nUnique content for prompt verification.";
      await writeText(paths.prd, prdContent);

      let capturedPrompt = "";
      const agent = {
        execute: (prompt: string, opts?: Record<string, unknown>) => {
          capturedPrompt = prompt;
          const onStdout = opts?.onStdout as ((chunk: string) => void) | undefined;
          const validJson = JSON.stringify({
            project: "test",
            branchName: "main",
            description: "d",
            tasks: [{ id: "AUTH-001", title: "T", description: "d", acceptanceCriteria: [], priority: 1, status: "open", iterationCount: 0 }],
          });
          onStdout?.(validJson);
          return {
            promise: Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
            interrupt: () => {},
            pid: 0,
            process: null as unknown,
          };
        },
      } as unknown as import("../agents/types.js").AgentAdapter;

      await generateTasks(agent, paths.prd, "test", "main", dir, { taskPrefix: "AUTH" });

      // The prompt sent to the agent must contain the PRD content
      expect(capturedPrompt).toContain("My Special PRD");
      expect(capturedPrompt).toContain("Unique content for prompt verification");
      // The prompt should use the custom task prefix
      expect(capturedPrompt).toContain("AUTH-001");
      expect(capturedPrompt).not.toContain("US-001");
    });
  });

  test("generateTasks rejects invalid JSON from agent output", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      await writeText(paths.prd, "# PRD\n\nContent");

      const agent = makeMockAgent("This is not JSON at all");

      await expect(
        generateTasks(agent, paths.prd, "test", "main", dir),
      ).rejects.toThrow("Failed to extract valid task JSON");
    });
  });

  test("generateTasks sets default values for missing task fields", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      await writeText(paths.prd, "# PRD");

      // Task missing status, iterationCount, notes
      const json = JSON.stringify({
        project: "test",
        branchName: "main",
        description: "d",
        tasks: [{ id: "US-001", title: "T", description: "d", acceptanceCriteria: [], priority: 1 }],
      });

      const agent = makeMockAgent(json);
      const result = await generateTasks(agent, paths.prd, "test", "main", dir);

      expect(result.tasks[0].status).toBe("open");
      expect(result.tasks[0].iterationCount).toBe(0);
    });
  });
});
