import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { Logger, initLogger, getLogger } from "../logging/logger.js";
import { withTmpDir } from "./helpers.js";
import type { LogEntry } from "../logging/types.js";

describe("Logger", () => {
  describe("JSON line format", () => {
    test("each level produces valid JSON with all required fields", async () => {
      await withTmpDir(async (dir) => {
        const logPath = join(dir, "test.log");
        const logger = new Logger(logPath);

        logger.debug("d:evt", "debug msg");
        logger.info("i:evt", "info msg");
        logger.warn("w:evt", "warn msg");
        logger.error("e:evt", "error msg");

        await Bun.sleep(100);

        const content = await readFile(logPath, "utf-8");
        const lines = content.trim().split("\n");
        expect(lines).toHaveLength(4);

        const levels = ["debug", "info", "warn", "error"] as const;
        const events = ["d:evt", "i:evt", "w:evt", "e:evt"];
        const messages = ["debug msg", "info msg", "warn msg", "error msg"];

        for (let i = 0; i < 4; i++) {
          const entry = JSON.parse(lines[i]) as LogEntry;
          expect(entry.level).toBe(levels[i]);
          expect(entry.event).toBe(events[i]);
          expect(entry.message).toBe(messages[i]);
          expect(entry.timestamp).toBeTruthy();
          expect(entry.service).toBeTruthy();
          expect(entry.env).toBeTruthy();
          // timestamp should be a valid ISO date
          expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
          if (entry.level === "error") {
            expect(entry.error).toBeTruthy();
            expect(entry.error?.type).toBeTruthy();
            expect(entry.error?.message).toBe("error msg");
          }
        }
      });
    });

    test("meta field is included when provided", async () => {
      await withTmpDir(async (dir) => {
        const logPath = join(dir, "test.log");
        const logger = new Logger(logPath);

        logger.info("test", "with meta", { key: "value", num: 42 });

        await Bun.sleep(100);

        const content = await readFile(logPath, "utf-8");
        const entry = JSON.parse(content.trim()) as LogEntry;
        expect(entry.meta).toEqual({ key: "value", num: 42 });
      });
    });

    test("meta field is omitted when not provided", async () => {
      await withTmpDir(async (dir) => {
        const logPath = join(dir, "test.log");
        const logger = new Logger(logPath);

        logger.info("test", "no meta");

        await Bun.sleep(100);

        const content = await readFile(logPath, "utf-8");
        const entry = JSON.parse(content.trim());
        expect("meta" in entry).toBe(false);
      });
    });

    test("non-serializable or oversized meta is safely truncated", async () => {
      await withTmpDir(async (dir) => {
        const logPath = join(dir, "test.log");
        const logger = new Logger(logPath);
        const meta: Record<string, unknown> = {
          payload: "x".repeat(20_000),
        };
        meta.self = meta;

        logger.info("test", "big meta", meta);

        await Bun.sleep(100);

        const content = await readFile(logPath, "utf-8");
        const entry = JSON.parse(content.trim()) as LogEntry;
        expect(entry.meta).toMatchObject({
          truncated: true,
        });
        expect(typeof entry.meta?.preview).toBe("string");
      });
    });
  });

  describe("subscribers", () => {
    test("subscriber is called with correct LogEntry", () => {
      const entries: LogEntry[] = [];
      const logger = new Logger("/dev/null");

      logger.subscribe((entry) => entries.push(entry));
      logger.info("test:event", "hello");

      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe("info");
      expect(entries[0].event).toBe("test:event");
      expect(entries[0].message).toBe("hello");
      expect(entries[0].timestamp).toBeTruthy();
    });

    test("multiple subscribers all receive entries", () => {
      const a: LogEntry[] = [];
      const b: LogEntry[] = [];
      const logger = new Logger("/dev/null");

      logger.subscribe((e) => a.push(e));
      logger.subscribe((e) => b.push(e));
      logger.warn("test", "msg");

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0]).toBe(b[0]);
    });

    test("unsubscribe stops notifications", () => {
      const entries: LogEntry[] = [];
      const logger = new Logger("/dev/null");

      const unsub = logger.subscribe((e) => entries.push(e));
      logger.info("a", "first");
      unsub();
      logger.info("b", "second");

      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe("a");
    });
  });

  describe("file append", () => {
    test("multiple writes append to the same file", async () => {
      await withTmpDir(async (dir) => {
        const logPath = join(dir, "test.log");
        const logger = new Logger(logPath);

        logger.info("first", "one");
        logger.info("second", "two");
        logger.info("third", "three");

        await Bun.sleep(100);

        const content = await readFile(logPath, "utf-8");
        const lines = content.trim().split("\n");
        expect(lines).toHaveLength(3);

        expect(JSON.parse(lines[0]).event).toBe("first");
        expect(JSON.parse(lines[1]).event).toBe("second");
        expect(JSON.parse(lines[2]).event).toBe("third");
      });
    });

    test("creates parent directories if needed", async () => {
      await withTmpDir(async (dir) => {
        const logPath = join(dir, "nested", "deep", "test.log");
        const logger = new Logger(logPath);

        logger.info("test", "nested");

        await Bun.sleep(100);

        const content = await readFile(logPath, "utf-8");
        const entry = JSON.parse(content.trim());
        expect(entry.event).toBe("test");
      });
    });
  });

  describe("write error handling", () => {
    test("does not throw on write failure", () => {
      const logger = new Logger("/nonexistent/impossible/path.log");

      expect(() => {
        logger.error("fail", "should not throw");
      }).not.toThrow();
    });
  });

  describe("singleton", () => {
    test("getLogger returns no-op when not initialized", () => {
      const logger = getLogger();

      // Log methods should not throw
      expect(() => {
        logger.debug("test", "noop");
        logger.info("test", "noop");
        logger.warn("test", "noop");
        logger.error("test", "noop");
      }).not.toThrow();

      // subscribe should return an unsubscribe function
      const unsub = logger.subscribe(() => {});
      expect(typeof unsub).toBe("function");
    });

    test("initLogger creates logger and getLogger returns it", async () => {
      await withTmpDir(async (dir) => {
        const logPath = join(dir, "singleton.log");
        const created = initLogger(logPath, { context: { request_id: "req-1" } });
        const retrieved = getLogger();

        expect(retrieved).toBe(created);

        retrieved.info("test", "singleton works");
        await Bun.sleep(100);

        const content = await readFile(logPath, "utf-8");
        const entry = JSON.parse(content.trim()) as LogEntry;
        expect(entry.event).toBe("test");
        expect(entry.message).toBe("singleton works");
        expect(entry.context?.request_id).toBe("req-1");
      });
    });
  });
});
