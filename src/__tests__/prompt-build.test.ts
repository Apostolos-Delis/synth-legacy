import { describe, test, expect } from "bun:test";
import { buildPrompt } from "../prompts/build.js";
import { buildIterationInstructions } from "../prompts/instructions.js";
import { makeSessionPaths, makeTask, withTmpDir } from "./helpers.js";

describe("buildPrompt", () => {
  test("includes buildIterationInstructions()", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const prompt = await buildPrompt(makeTask(), paths, dir, 1);
      expect(prompt).toContain(buildIterationInstructions());
    });
  });

  test("includes task ID, title, priority, description", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const task = makeTask({
        id: "US-042",
        title: "Add auth",
        priority: 1,
        description: "Implement OAuth2 login",
      });
      const prompt = await buildPrompt(task, paths, dir, 1);
      expect(prompt).toContain("US-042");
      expect(prompt).toContain("Add auth");
      expect(prompt).toContain("1");
      expect(prompt).toContain("Implement OAuth2 login");
    });
  });

  test("includes acceptance criteria as checklist", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const task = makeTask({
        acceptanceCriteria: ["Users can log in", "Sessions persist"],
      });
      const prompt = await buildPrompt(task, paths, dir, 1);
      expect(prompt).toContain("- [ ] #1: Users can log in");
      expect(prompt).toContain("- [ ] #2: Sessions persist");
    });
  });

  test("includes verification commands when present", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const task = makeTask({
        verification: [
          { type: "command", value: "bun run test" },
          { type: "command", value: "bun run typecheck" },
        ],
      });
      const prompt = await buildPrompt(task, paths, dir, 1);
      expect(prompt).toContain("`bun run test`");
      expect(prompt).toContain("`bun run typecheck`");
    });
  });

  test("includes task notes from previous attempts when present", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const task = makeTask({
        notes: "Failed due to missing dependency",
      });
      const prompt = await buildPrompt(task, paths, dir, 1);
      expect(prompt).toContain("Failed due to missing dependency");
      expect(prompt).toContain("Notes from Previous Attempts");
    });
  });

  test("includes project context when provided", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const prompt = await buildPrompt(
        makeTask(),
        paths,
        dir,
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        { projectContext: "# Project Rules\nUse TypeScript only." },
      );
      expect(prompt).toContain("Project Context (AGENTS.md)");
      expect(prompt).toContain("Use TypeScript only.");
    });
  });

  test("includes codebase patterns when progress is provided", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const progress = `## Codebase Patterns\n- Always use async/await\n- Tests in __tests__\n\n## Other Section\nStuff here`;
      const prompt = await buildPrompt(
        makeTask(),
        paths,
        dir,
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        { progress },
      );
      expect(prompt).toContain("Codebase Patterns (from previous iterations)");
      expect(prompt).toContain("Always use async/await");
    });
  });

  test("includes recent progress entries when progress is provided", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const entries = Array.from({ length: 7 }, (_, i) => `Entry ${i + 1}`);
      const progress = entries.join("\n---\n");
      const prompt = await buildPrompt(
        makeTask(),
        paths,
        dir,
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        { progress },
      );
      expect(prompt).toContain("Recent Progress");
      expect(prompt).toContain("Entry 7");
      expect(prompt).toContain("Entry 3");
    });
  });

  test("omits project context section when not provided", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const prompt = await buildPrompt(makeTask(), paths, dir, 1);
      expect(prompt).not.toContain("Project Context (AGENTS.md)");
    });
  });

  test("omits progress sections when progress is not provided", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const prompt = await buildPrompt(makeTask(), paths, dir, 1);
      expect(prompt).not.toContain("Codebase Patterns");
      expect(prompt).not.toContain("Recent Progress");
    });
  });

  test("includes Claude-specific guidance when agentName is 'claude'", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const prompt = await buildPrompt(makeTask(), paths, dir, 1, "claude");
      expect(prompt).toContain("Agent-Specific Guidance (Claude)");
      expect(prompt).toContain("Task tool with subagent_type");
    });
  });

  test("includes Codex-specific guidance when agentName is 'codex'", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const prompt = await buildPrompt(makeTask(), paths, dir, 1, "codex");
      expect(prompt).toContain("Agent-Specific Guidance (Codex)");
      expect(prompt).toContain("apply patch tool");
    });
  });

  test("omits agent-specific section for unrecognized agent type", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const prompt = await buildPrompt(makeTask(), paths, dir, 1, "unknown-agent");
      expect(prompt).not.toContain("Agent-Specific Guidance");
      expect(prompt).toContain(buildIterationInstructions());
    });
  });

  test("omits agent-specific section when agentName is undefined", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const prompt = await buildPrompt(makeTask(), paths, dir, 1);
      expect(prompt).not.toContain("Agent-Specific Guidance");
    });
  });

  test("agent-specific section appears after generic instructions", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const prompt = await buildPrompt(makeTask(), paths, dir, 1, "claude");
      const instructionsIdx = prompt.indexOf(buildIterationInstructions());
      const agentIdx = prompt.indexOf("Agent-Specific Guidance (Claude)");
      expect(instructionsIdx).toBeGreaterThanOrEqual(0);
      expect(agentIdx).toBeGreaterThan(instructionsIdx);
    });
  });

  test("avoids manual commit instructions even when slug provided", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const prompt = await buildPrompt(makeTask(), paths, dir, 1, "claude", "jwt-auth");
      expect(prompt).toContain("auto-commits after task completion");
      expect(prompt).not.toContain("feat: [jwt-auth]");
    });
  });

  test("does not include commit message placeholders when slug not provided", async () => {
    await withTmpDir(async (dir) => {
      const paths = makeSessionPaths(dir);
      const prompt = await buildPrompt(makeTask(), paths, dir, 1);
      expect(prompt).not.toContain("feat: [session-slug]");
    });
  });
});
