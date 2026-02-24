import { describe, test, expect } from "bun:test";
import {
  tryFastPathResolution,
  buildConflictPrompt,
  extractResolvedContent,
  resolveWithAi,
} from "./ai-resolver.js";
import type { AiAgent, ConflictInfo } from "./ai-resolver.js";

describe("tryFastPathResolution", () => {
  test("returns ours/theirs when both identical", () => {
    expect(tryFastPathResolution("base", "same", "same")).toBe("same");
  });

  test("returns theirs when ours is empty", () => {
    expect(tryFastPathResolution("base", "", "theirs content")).toBe(
      "theirs content",
    );
  });

  test("returns ours when theirs is empty", () => {
    expect(tryFastPathResolution("base", "ours content", "")).toBe(
      "ours content",
    );
  });

  test("returns theirs when ours equals base (no local changes)", () => {
    expect(tryFastPathResolution("base", "base", "theirs content")).toBe(
      "theirs content",
    );
  });

  test("returns ours when theirs equals base (no remote changes)", () => {
    expect(tryFastPathResolution("base", "ours content", "base")).toBe(
      "ours content",
    );
  });

  test("returns null for non-trivial conflicts", () => {
    expect(
      tryFastPathResolution("base", "ours change", "theirs change"),
    ).toBeNull();
  });

  test("returns null when both sides changed differently from base", () => {
    expect(
      tryFastPathResolution(
        "original\nline 2",
        "modified-ours\nline 2",
        "original\nmodified-theirs",
      ),
    ).toBeNull();
  });
});

describe("buildConflictPrompt", () => {
  test("includes file path, task ID, and task title", () => {
    const prompt = buildConflictPrompt(
      "src/index.ts",
      "base",
      "ours",
      "theirs",
      "COOR-001",
      "Add feature",
    );

    expect(prompt).toContain("src/index.ts");
    expect(prompt).toContain("COOR-001");
    expect(prompt).toContain("Add feature");
  });

  test("includes base, ours, and theirs content", () => {
    const prompt = buildConflictPrompt(
      "file.ts",
      "base content here",
      "ours content here",
      "theirs content here",
      "T-1",
      "Title",
    );

    expect(prompt).toContain("base content here");
    expect(prompt).toContain("ours content here");
    expect(prompt).toContain("theirs content here");
  });

  test("includes section markers", () => {
    const prompt = buildConflictPrompt(
      "f.ts",
      "b",
      "o",
      "t",
      "T-1",
      "Title",
    );

    expect(prompt).toContain("BASE");
    expect(prompt).toContain("OURS");
    expect(prompt).toContain("THEIRS");
  });
});

describe("extractResolvedContent", () => {
  test("strips markdown code fences", () => {
    const input = "```typescript\nconst x = 1;\n```";
    expect(extractResolvedContent(input)).toBe("const x = 1;");
  });

  test("strips plain code fences", () => {
    const input = "```\nconst x = 1;\n```";
    expect(extractResolvedContent(input)).toBe("const x = 1;");
  });

  test("returns raw content when no fences present", () => {
    const input = "const x = 1;";
    expect(extractResolvedContent(input)).toBe("const x = 1;");
  });

  test("handles multiline content inside fences", () => {
    const input = "```ts\nline 1\nline 2\nline 3\n```";
    expect(extractResolvedContent(input)).toBe("line 1\nline 2\nline 3");
  });

  test("trims surrounding whitespace before matching", () => {
    const input = "\n  ```js\ncontent\n```  \n";
    expect(extractResolvedContent(input)).toBe("content");
  });
});

describe("resolveWithAi", () => {
  const makeConflict = (
    overrides: Partial<ConflictInfo> = {},
  ): ConflictInfo => ({
    file: "src/index.ts",
    base: "base",
    ours: "ours",
    theirs: "theirs",
    taskId: "COOR-001",
    taskTitle: "Test task",
    ...overrides,
  });

  const makeAgent = (response: string): AiAgent => ({
    resolve: async () => response,
  });

  test("returns fast-path result without calling agent", async () => {
    let agentCalled = false;
    const agent: AiAgent = {
      resolve: async () => {
        agentCalled = true;
        return "should not be called";
      },
    };

    const result = await resolveWithAi(
      makeConflict({ ours: "same", theirs: "same" }),
      agent,
      "/repo",
    );

    expect(result).toBe("same");
    expect(agentCalled).toBe(false);
  });

  test("calls agent for non-trivial conflicts", async () => {
    const agent = makeAgent("```ts\nresolved content\n```");

    const result = await resolveWithAi(
      makeConflict({ ours: "change A", theirs: "change B" }),
      agent,
      "/repo",
    );

    expect(result).toBe("resolved content");
  });

  test("passes cwd to agent", async () => {
    let receivedCwd = "";
    const agent: AiAgent = {
      resolve: async (_prompt, cwd) => {
        receivedCwd = cwd;
        return "resolved";
      },
    };

    await resolveWithAi(
      makeConflict({ ours: "a", theirs: "b" }),
      agent,
      "/my/repo",
    );

    expect(receivedCwd).toBe("/my/repo");
  });

  test("builds prompt with conflict info for agent", async () => {
    let receivedPrompt = "";
    const agent: AiAgent = {
      resolve: async (prompt) => {
        receivedPrompt = prompt;
        return "resolved";
      },
    };

    await resolveWithAi(
      makeConflict({
        file: "src/app.ts",
        ours: "our change",
        theirs: "their change",
        taskId: "COOR-042",
        taskTitle: "Fix bug",
      }),
      agent,
      "/repo",
    );

    expect(receivedPrompt).toContain("src/app.ts");
    expect(receivedPrompt).toContain("COOR-042");
    expect(receivedPrompt).toContain("Fix bug");
    expect(receivedPrompt).toContain("our change");
    expect(receivedPrompt).toContain("their change");
  });
});
