import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import {
  readJson,
  writeJson,
  readText,
  writeText,
  appendText,
  fileExists,
  ensureDir,
  dirExists,
} from "../utils/fs.js";
import { withTmpDir } from "./helpers.js";

describe("file utilities", () => {
  test("writeJson + readJson round-trips data", async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, "data.json");
      const data = { key: "value", nested: { arr: [1, 2, 3] } };
      await writeJson(path, data);
      const loaded = await readJson<typeof data>(path);
      expect(loaded).toEqual(data);
    });
  });

  test("writeText + readText round-trips content", async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, "file.txt");
      await writeText(path, "hello world\nsecond line");
      const content = await readText(path);
      expect(content).toBe("hello world\nsecond line");
    });
  });

  test("appendText appends to existing file", async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, "append.txt");
      await writeText(path, "line1\n");
      await appendText(path, "line2\n");
      const content = await readText(path);
      expect(content).toBe("line1\nline2\n");
    });
  });

  test("appendText creates file if missing", async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, "new.txt");
      await appendText(path, "first line");
      const content = await readText(path);
      expect(content).toBe("first line");
    });
  });

  test("fileExists returns true for existing file", async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, "exists.txt");
      await writeText(path, "content");
      expect(await fileExists(path)).toBe(true);
    });
  });

  test("fileExists returns false for missing file", async () => {
    await withTmpDir(async (dir) => {
      expect(await fileExists(join(dir, "nope.txt"))).toBe(false);
    });
  });

  test("ensureDir creates nested directories", async () => {
    await withTmpDir(async (dir) => {
      const nested = join(dir, "a", "b", "c");
      await ensureDir(nested);
      expect(await dirExists(nested)).toBe(true);
    });
  });

  test("ensureDir is idempotent", async () => {
    await withTmpDir(async (dir) => {
      const nested = join(dir, "x", "y");
      await ensureDir(nested);
      await ensureDir(nested);
      expect(await dirExists(nested)).toBe(true);
    });
  });

  test("dirExists returns true for existing directory", async () => {
    await withTmpDir(async (dir) => {
      expect(await dirExists(dir)).toBe(true);
    });
  });

  test("dirExists returns false for missing directory", async () => {
    await withTmpDir(async (dir) => {
      expect(await dirExists(join(dir, "nope"))).toBe(false);
    });
  });
});
