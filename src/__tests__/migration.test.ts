import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { migrateStorageAt } from "../sessions/registry.js";
import { dirExists, fileExists, readJson } from "../utils/fs.js";
import { withTmpDir } from "./helpers.js";

async function mkdirp(path: string) {
  await mkdir(path, { recursive: true });
}

async function touch(path: string, content = "{}") {
  await writeFile(path, content);
}

describe("migrateStorageAt", () => {
  test("no-op when neither plans nor sessions exist", async () => {
    await withTmpDir(async (dir) => {
      const plans = join(dir, "plans");
      const sessions = join(dir, "sessions");
      await migrateStorageAt(plans, sessions);
      expect(await dirExists(plans)).toBe(false);
      expect(await dirExists(sessions)).toBe(false);
    });
  });

  // Branch 1: simple rename — plans exist, sessions don't
  test("renames plans to sessions when only plans exist", async () => {
    await withTmpDir(async (dir) => {
      const plans = join(dir, "plans");
      const sessions = join(dir, "sessions");

      // Set up legacy structure: plans/repo-a/sess-1/session.json
      await mkdirp(join(plans, "repo-a", "sess-1"));
      await touch(join(plans, "repo-a", "sess-1", "session.json"), '{"id":"sess-1"}');

      await migrateStorageAt(plans, sessions);

      // plans dir should be gone, sessions should exist
      expect(await dirExists(plans)).toBe(false);
      expect(await dirExists(sessions)).toBe(true);
      // session.json should be renamed to run.json
      expect(await fileExists(join(sessions, "repo-a", "sess-1", "run.json"))).toBe(true);
      expect(await fileExists(join(sessions, "repo-a", "sess-1", "session.json"))).toBe(false);
    });
  });

  // Branch 2: merge — both plans and sessions exist
  test("merges plans into sessions when both exist", async () => {
    await withTmpDir(async (dir) => {
      const plans = join(dir, "plans");
      const sessions = join(dir, "sessions");

      // Legacy: plans/repo-a/sess-1 and plans/repo-b/sess-3
      await mkdirp(join(plans, "repo-a", "sess-1"));
      await touch(join(plans, "repo-a", "sess-1", "session.json"), '{"id":"sess-1"}');
      await mkdirp(join(plans, "repo-b", "sess-3"));
      await touch(join(plans, "repo-b", "sess-3", "session.json"), '{"id":"sess-3"}');

      // Existing sessions: sessions/repo-a/sess-2
      await mkdirp(join(sessions, "repo-a", "sess-2"));
      await touch(join(sessions, "repo-a", "sess-2", "run.json"), '{"id":"sess-2"}');

      await migrateStorageAt(plans, sessions);

      // plans dir should be cleaned up
      expect(await dirExists(plans)).toBe(false);

      // sess-1 should be merged into sessions/repo-a/
      expect(await dirExists(join(sessions, "repo-a", "sess-1"))).toBe(true);
      // sess-2 should still exist
      expect(await fileExists(join(sessions, "repo-a", "sess-2", "run.json"))).toBe(true);
      // repo-b should be moved over
      expect(await dirExists(join(sessions, "repo-b", "sess-3"))).toBe(true);

      // session.json files should be renamed to run.json
      expect(await fileExists(join(sessions, "repo-a", "sess-1", "run.json"))).toBe(true);
      expect(await fileExists(join(sessions, "repo-b", "sess-3", "run.json"))).toBe(true);
    });
  });

  test("merge skips duplicate session IDs", async () => {
    await withTmpDir(async (dir) => {
      const plans = join(dir, "plans");
      const sessions = join(dir, "sessions");

      // Both have repo-a/sess-1
      await mkdirp(join(plans, "repo-a", "sess-1"));
      await touch(join(plans, "repo-a", "sess-1", "session.json"), '{"from":"plans"}');
      await mkdirp(join(sessions, "repo-a", "sess-1"));
      await touch(join(sessions, "repo-a", "sess-1", "run.json"), '{"from":"sessions"}');

      await migrateStorageAt(plans, sessions);

      // sessions version should be preserved (not overwritten)
      const data = await readJson<{ from: string }>(
        join(sessions, "repo-a", "sess-1", "run.json"),
      );
      expect(data.from).toBe("sessions");

      // legacy dir should be retained because entries were skipped
      expect(await dirExists(plans)).toBe(true);
    });
  });

  // Branch 3: session.json → run.json rename (no plans involved)
  test("renames session.json to run.json when only sessions exist", async () => {
    await withTmpDir(async (dir) => {
      const plans = join(dir, "plans");
      const sessions = join(dir, "sessions");

      await mkdirp(join(sessions, "repo-a", "sess-1"));
      await touch(join(sessions, "repo-a", "sess-1", "session.json"), '{"id":"sess-1"}');
      await mkdirp(join(sessions, "repo-a", "sess-2"));
      await touch(join(sessions, "repo-a", "sess-2", "session.json"), '{"id":"sess-2"}');
      // sess-3 already has run.json — should not be touched
      await mkdirp(join(sessions, "repo-a", "sess-3"));
      await touch(join(sessions, "repo-a", "sess-3", "run.json"), '{"id":"sess-3"}');

      await migrateStorageAt(plans, sessions);

      expect(await fileExists(join(sessions, "repo-a", "sess-1", "run.json"))).toBe(true);
      expect(await fileExists(join(sessions, "repo-a", "sess-1", "session.json"))).toBe(false);
      expect(await fileExists(join(sessions, "repo-a", "sess-2", "run.json"))).toBe(true);
      expect(await fileExists(join(sessions, "repo-a", "sess-2", "session.json"))).toBe(false);
      // sess-3 should still have run.json
      expect(await fileExists(join(sessions, "repo-a", "sess-3", "run.json"))).toBe(true);
    });
  });

  test("does not rename session.json if run.json already exists", async () => {
    await withTmpDir(async (dir) => {
      const plans = join(dir, "plans");
      const sessions = join(dir, "sessions");

      await mkdirp(join(sessions, "repo-a", "sess-1"));
      await touch(join(sessions, "repo-a", "sess-1", "session.json"), '{"old":true}');
      await touch(join(sessions, "repo-a", "sess-1", "run.json"), '{"new":true}');

      await migrateStorageAt(plans, sessions);

      // run.json should be untouched
      const data = await readJson<{ new: boolean }>(
        join(sessions, "repo-a", "sess-1", "run.json"),
      );
      expect(data.new).toBe(true);
      // session.json should still be there (not deleted, just not renamed)
      expect(await fileExists(join(sessions, "repo-a", "sess-1", "session.json"))).toBe(true);
    });
  });

  test("ignores non-directory entries in plans and sessions", async () => {
    await withTmpDir(async (dir) => {
      const plans = join(dir, "plans");
      const sessions = join(dir, "sessions");

      // Put a stray file in plans — should be ignored during merge
      await mkdirp(plans);
      await touch(join(plans, "stray-file.txt"), "stray");
      await mkdirp(sessions);

      await migrateStorageAt(plans, sessions);

      // Should not crash, sessions dir should still exist
      expect(await dirExists(sessions)).toBe(true);
    });
  });
});
