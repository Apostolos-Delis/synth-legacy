import { watch } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { LogEntry } from "./types.js";

/**
 * Stream log entries from a JSONL file line by line without loading the full
 * file into memory.  Lines that aren't valid JSON are skipped with a stderr
 * warning.
 */
export async function* readLogFile(path: string): AsyncGenerator<LogEntry> {
  const handle = await open(path, "r");
  try {
    const bufSize = 8192;
    const buf = Buffer.alloc(bufSize);
    let remainder = "";

    while (true) {
      const { bytesRead } = await handle.read(buf, 0, bufSize);
      if (bytesRead === 0) break;

      const chunk = remainder + buf.toString("utf8", 0, bytesRead);
      const lines = chunk.split("\n");

      // Last element is either empty (line ended with \n) or a partial line
      remainder = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          yield JSON.parse(trimmed) as LogEntry;
        } catch {
          process.stderr.write(`[log-reader] skipping unparseable line: ${trimmed}\n`);
        }
      }
    }

    // Handle any trailing content without a final newline
    if (remainder.trim() !== "") {
      try {
        yield JSON.parse(remainder.trim()) as LogEntry;
      } catch {
        process.stderr.write(`[log-reader] skipping unparseable line: ${remainder.trim()}\n`);
      }
    }
  } finally {
    await handle.close();
  }
}

/**
 * Read existing log entries then watch for new appends, calling `onEntry` for
 * each parsed LogEntry.  Uses an AbortSignal for clean shutdown.
 *
 * Internally reads from the current file offset whenever the watcher fires,
 * avoiding full-file reloads.
 */
export async function tailLogFile(
  path: string,
  onEntry: (entry: LogEntry) => void,
  signal: AbortSignal,
): Promise<void> {
  // Read existing content first
  const handle = await open(path, "r");

  let offset = 0;
  let remainder = "";

  const processChunk = async () => {
    const bufSize = 8192;
    const buf = Buffer.alloc(bufSize);

    while (true) {
      const { bytesRead } = await handle.read(buf, 0, bufSize, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;

      const chunk = remainder + buf.toString("utf8", 0, bytesRead);
      const lines = chunk.split("\n");
      remainder = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          onEntry(JSON.parse(trimmed) as LogEntry);
        } catch {
          process.stderr.write(`[log-reader] skipping unparseable line: ${trimmed}\n`);
        }
      }
    }

    // Handle trailing content without a final newline
    if (remainder.trim() !== "") {
      try {
        onEntry(JSON.parse(remainder.trim()) as LogEntry);
        remainder = "";
      } catch {
        // Partial JSON — keep in remainder for next read
      }
    }
  };

  // Read all existing content
  await processChunk();

  if (signal.aborted) {
    await handle.close();
    return;
  }

  // Watch for new appends
  return new Promise<void>((resolve) => {
    const watcher = watch(path, async () => {
      try {
        await processChunk();
      } catch {
        // File may have been removed or truncated — ignore
      }
    });

    const cleanup = async () => {
      watcher.close();
      await handle.close();
      resolve();
    };

    signal.addEventListener("abort", () => void cleanup(), { once: true });
  });
}

/**
 * Check whether the log file indicates a completed session by looking for a
 * state:change event with a "completed" message.  Reads only the tail of the
 * file to avoid loading the entire log into memory.
 */
export async function isSessionComplete(path: string): Promise<boolean> {
  const tailSize = 4096;
  let fileSize: number;
  try {
    fileSize = (await stat(path)).size;
  } catch {
    return false;
  }

  const handle = await open(path, "r");
  try {
    const readFrom = Math.max(0, fileSize - tailSize);
    const buf = Buffer.alloc(Math.min(tailSize, fileSize));
    const { bytesRead } = await handle.read(buf, 0, buf.length, readFrom);
    const tail = buf.toString("utf8", 0, bytesRead);

    // Parse lines from the tail, checking in reverse order
    const lines = tail.split("\n").filter((l) => l.trim() !== "");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as LogEntry;
        if (entry.event === "state:change" && entry.msg === "completed") {
          return true;
        }
      } catch {
        // skip unparseable
      }
    }

    return false;
  } finally {
    await handle.close();
  }
}
