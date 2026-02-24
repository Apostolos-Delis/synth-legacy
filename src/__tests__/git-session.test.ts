import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { getSessionDiff, getSessionCommits, truncateDiff } from "../utils/git.js";
import { spawn } from "../utils/process.js";

async function withGitRepo(fn: (cwd: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "synth-git-test-"));
  try {
    await run(dir, ["git", "init"]);
    await run(dir, ["git", "config", "user.email", "test@test.com"]);
    await run(dir, ["git", "config", "user.name", "Test"]);
    // Create initial commit on main
    await Bun.write(join(dir, "README.md"), "# init");
    await run(dir, ["git", "add", "."]);
    await run(dir, ["git", "commit", "-m", "init"]);
    await run(dir, ["git", "branch", "-M", "main"]);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

async function run(cwd: string, cmd: string[]): Promise<string> {
  const result = await spawn({ cmd, cwd }).promise;
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${cmd.join(" ")}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// truncateDiff
// ---------------------------------------------------------------------------

describe("truncateDiff", () => {
  test("returns diff unchanged when under limit", () => {
    const diff = "a".repeat(100);
    expect(truncateDiff(diff, 200)).toBe(diff);
  });

  test("returns diff unchanged when exactly at limit", () => {
    const diff = "a".repeat(200);
    expect(truncateDiff(diff, 200)).toBe(diff);
  });

  test("truncates with marker when over limit", () => {
    const diff = "a".repeat(300);
    const result = truncateDiff(diff, 200);
    expect(result).toStartWith("a".repeat(200));
    expect(result).toContain("[... diff truncated at 200 characters");
    expect(result).toContain("100 characters omitted]");
  });

  test("uses MAX_DIFF_SIZE as default", () => {
    const small = "x".repeat(100);
    expect(truncateDiff(small)).toBe(small);
  });
});

// ---------------------------------------------------------------------------
// getSessionDiff
// ---------------------------------------------------------------------------

describe("getSessionDiff", () => {
  test("returns full branch diff when no slug provided", async () => {
    await withGitRepo(async (cwd) => {
      await run(cwd, ["git", "checkout", "-b", "feature"]);
      await Bun.write(join(cwd, "file.ts"), "export const x = 1;");
      await run(cwd, ["git", "add", "."]);
      await run(cwd, ["git", "commit", "-m", "feat: add file"]);

      const result = await getSessionDiff(cwd, "main");
      expect(result.sessionScoped).toBe(false);
      expect(result.diff).toContain("file.ts");
    });
  });

  test("returns full branch diff when slug is 'synth' (default)", async () => {
    await withGitRepo(async (cwd) => {
      await run(cwd, ["git", "checkout", "-b", "feature"]);
      await Bun.write(join(cwd, "file.ts"), "export const x = 1;");
      await run(cwd, ["git", "add", "."]);
      await run(cwd, ["git", "commit", "-m", "feat: [synth] add file"]);

      const result = await getSessionDiff(cwd, "main", "synth");
      expect(result.sessionScoped).toBe(false);
      expect(result.diff).toContain("file.ts");
    });
  });

  test("scopes diff to session files when slug matches", async () => {
    await withGitRepo(async (cwd) => {
      await run(cwd, ["git", "checkout", "-b", "feature"]);

      // Commit from a different session
      await Bun.write(join(cwd, "other.ts"), "export const other = 1;");
      await run(cwd, ["git", "add", "."]);
      await run(cwd, ["git", "commit", "-m", "feat: [other-session] other file"]);

      // Commit from our session
      await Bun.write(join(cwd, "mine.ts"), "export const mine = 1;");
      await run(cwd, ["git", "add", "."]);
      await run(cwd, ["git", "commit", "-m", "feat: [my-session] my file"]);

      const result = await getSessionDiff(cwd, "main", "my-session");
      expect(result.sessionScoped).toBe(true);
      expect(result.diff).toContain("mine.ts");
      expect(result.diff).not.toContain("other.ts");
    });
  });

  test("falls back to full diff when slug has no matching commits", async () => {
    await withGitRepo(async (cwd) => {
      await run(cwd, ["git", "checkout", "-b", "feature"]);
      await Bun.write(join(cwd, "file.ts"), "export const x = 1;");
      await run(cwd, ["git", "add", "."]);
      await run(cwd, ["git", "commit", "-m", "feat: some work"]);

      const result = await getSessionDiff(cwd, "main", "nonexistent-slug");
      expect(result.sessionScoped).toBe(false);
      expect(result.diff).toContain("file.ts");
    });
  });

  test("returns empty diff when no changes on branch", async () => {
    await withGitRepo(async (cwd) => {
      await run(cwd, ["git", "checkout", "-b", "feature"]);
      const result = await getSessionDiff(cwd, "main");
      expect(result.sessionScoped).toBe(false);
      expect(result.diff).toBe("");
    });
  });
});

// ---------------------------------------------------------------------------
// getSessionCommits
// ---------------------------------------------------------------------------

describe("getSessionCommits", () => {
  test("returns commit hashes matching slug", async () => {
    await withGitRepo(async (cwd) => {
      await run(cwd, ["git", "checkout", "-b", "feature"]);

      await Bun.write(join(cwd, "a.ts"), "1");
      await run(cwd, ["git", "add", "."]);
      await run(cwd, ["git", "commit", "-m", "feat: [my-slug] first"]);

      await Bun.write(join(cwd, "b.ts"), "2");
      await run(cwd, ["git", "add", "."]);
      await run(cwd, ["git", "commit", "-m", "feat: unrelated"]);

      await Bun.write(join(cwd, "c.ts"), "3");
      await run(cwd, ["git", "add", "."]);
      await run(cwd, ["git", "commit", "-m", "feat: [my-slug] second"]);

      const commits = await getSessionCommits(cwd, "main", "my-slug");
      expect(commits).toHaveLength(2);
      // Commits are in reverse chronological order (most recent first)
      for (const hash of commits) {
        expect(hash).toMatch(/^[0-9a-f]{40}$/);
      }
    });
  });

  test("returns empty array when no commits match", async () => {
    await withGitRepo(async (cwd) => {
      await run(cwd, ["git", "checkout", "-b", "feature"]);
      await Bun.write(join(cwd, "a.ts"), "1");
      await run(cwd, ["git", "add", "."]);
      await run(cwd, ["git", "commit", "-m", "feat: some work"]);

      const commits = await getSessionCommits(cwd, "main", "nonexistent");
      expect(commits).toHaveLength(0);
    });
  });
});
