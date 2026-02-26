import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import type { LogEntry } from "../logging/types.js";
import { withTmpDir } from "./helpers.js";

describe("Session log JSONL", () => {
  test("createSession and getLogger write JSONL with request_id", async () => {
    await withTmpDir(async (dir) => {
      const originalSynthHome = process.env.SYNTH_HOME;
      process.env.SYNTH_HOME = `${dir}/.synth`;

      try {
        const { createSession } = await import("../sessions/registry.js");
        const { getLogger } = await import("../logging/logger.js");

        const { paths } = await createSession(dir, "session log test");
        const requestId = "req-123";

        getLogger().info("test:request", "logged request", {
          request_id: requestId,
        });

        await Bun.sleep(100);

        const content = await readFile(paths.sessionLog, "utf-8");
        const lines = content.split("\n").filter((line) => line.trim() !== "");
        const entry = lines
          .map((line) => JSON.parse(line) as LogEntry)
          .find((line) => line.event === "test:request");

        expect(entry).toBeTruthy();
        expect(entry?.level).toBe("info");
        expect(entry?.event).toBe("test:request");
        expect(entry?.msg).toBe("logged request");
        expect(entry?.ts).toBeTruthy();
        expect(Number.isNaN(Date.parse(entry?.ts ?? ""))).toBe(false);
        expect(entry?.meta).toBeTruthy();
        expect(entry?.meta?.request_id).toBe(requestId);
      } finally {
        if (originalSynthHome === undefined) {
          delete process.env.SYNTH_HOME;
        } else {
          process.env.SYNTH_HOME = originalSynthHome;
        }
      }
    });
  });
});
