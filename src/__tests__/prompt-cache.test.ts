import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { LogEntry } from "../logging/types.js";
import { initLogger } from "../logging/logger.js";
import { createPromptCache } from "../engine/prompt-cache.js";
import { writeText } from "../utils/fs.js";
import { withTmpDir } from "./helpers.js";

describe("prompt cache", () => {
  test("logs hit/miss with sessionId, phase, and component", async () => {
    await withTmpDir(async (dir) => {
      const logPath = join(dir, "session.log");
      const logger = initLogger(logPath);
      const entries: LogEntry[] = [];
      logger.subscribe((entry) => entries.push(entry));

      const cache = createPromptCache();
      const path = join(dir, "AGENTS.md");
      const options = {
        path,
        component: "agents" as const,
        sessionId: "test-session",
        phase: "build:read-files",
      };

      await writeText(path, "alpha");
      expect(await cache.readText(options)).toBe("alpha");
      expect(await cache.readText(options)).toBe("alpha");

      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeText(path, "beta");
      expect(await cache.readText(options)).toBe("beta");

      const hits = entries.filter((entry) => entry.event === "prompt-cache:hit");
      const misses = entries.filter((entry) => entry.event === "prompt-cache:miss");

      expect(hits.length).toBeGreaterThan(0);
      expect(misses.length).toBeGreaterThan(1);
      expect(hits[0]?.meta).toMatchObject({
        sessionId: "test-session",
        phase: "build:read-files",
        component: "agents",
      });
      expect(misses[0]?.meta).toMatchObject({
        sessionId: "test-session",
        phase: "build:read-files",
        component: "agents",
      });
    });
  });
});
