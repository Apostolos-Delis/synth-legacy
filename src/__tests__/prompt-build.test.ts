import { describe, test, expect } from "bun:test";
import { buildPrompt } from "../prompts/build.js";
import { ITERATION_INSTRUCTIONS } from "../prompts/instructions.js";
import { writeText } from "../utils/fs.js";
import { join } from "node:path";
import { makePlanPaths, makeTask, withTmpDir } from "./helpers.js";

describe("buildPrompt", () => {
  test("includes ITERATION_INSTRUCTIONS", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      const prompt = await buildPrompt(makeTask(), paths, dir, 1);
      expect(prompt).toContain(ITERATION_INSTRUCTIONS);
    });
  });

  test("includes task ID, title, priority, description", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
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
      const paths = makePlanPaths(dir);
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
      const paths = makePlanPaths(dir);
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
      const paths = makePlanPaths(dir);
      const task = makeTask({
        notes: "Failed due to missing dependency",
      });
      const prompt = await buildPrompt(task, paths, dir, 1);
      expect(prompt).toContain("Failed due to missing dependency");
      expect(prompt).toContain("Notes from Previous Attempts");
    });
  });

  test("includes AGENTS.md content when file exists in cwd", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      await writeText(join(dir, "AGENTS.md"), "# Project Rules\nUse TypeScript only.");
      const prompt = await buildPrompt(makeTask(), paths, dir, 1);
      expect(prompt).toContain("Project Context (AGENTS.md)");
      expect(prompt).toContain("Use TypeScript only.");
    });
  });

  test("includes codebase patterns from progress.md", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      await writeText(paths.progress, `## Codebase Patterns\n- Always use async/await\n- Tests in __tests__\n\n## Other Section\nStuff here`);
      const prompt = await buildPrompt(makeTask(), paths, dir, 1);
      expect(prompt).toContain("Codebase Patterns (from previous iterations)");
      expect(prompt).toContain("Always use async/await");
    });
  });

  test("includes recent progress entries", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      const entries = Array.from({ length: 7 }, (_, i) => `Entry ${i + 1}`);
      await writeText(paths.progress, entries.join("\n---\n"));
      const prompt = await buildPrompt(makeTask(), paths, dir, 1);
      expect(prompt).toContain("Recent Progress");
      expect(prompt).toContain("Entry 7");
      expect(prompt).toContain("Entry 3");
    });
  });

  test("omits AGENTS.md section when file doesn't exist", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      const prompt = await buildPrompt(makeTask(), paths, dir, 1);
      expect(prompt).not.toContain("Project Context (AGENTS.md)");
    });
  });

  test("omits progress sections when progress.md doesn't exist", async () => {
    await withTmpDir(async (dir) => {
      const paths = makePlanPaths(dir);
      const prompt = await buildPrompt(makeTask(), paths, dir, 1);
      expect(prompt).not.toContain("Codebase Patterns");
      expect(prompt).not.toContain("Recent Progress");
    });
  });
});
