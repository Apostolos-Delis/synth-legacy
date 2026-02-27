import { readFile } from "node:fs/promises";

type SpanEntry = {
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
  minMs: number;
  avgMs: number;
};

type ProfileEntry = {
  ts: string;
  spans?: SpanEntry[];
  events?: Record<string, number>;
};

function fmtMs(value: number): string {
  return `${Math.round(value * 100) / 100}ms`;
}

function pad(text: string, len: number): string {
  if (text.length >= len) return text;
  return text + " ".repeat(len - text.length);
}

const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/tui-profile-report.ts <path-to-tui-profile.jsonl>");
  process.exit(1);
}

const raw = await readFile(path, "utf8");
const lines = raw.split("\n").filter(Boolean);
if (lines.length === 0) {
  console.error("no profile entries found");
  process.exit(1);
}

const entries: ProfileEntry[] = lines.map((line) => JSON.parse(line));
const spanTotals = new Map<string, { count: number; totalMs: number; maxMs: number }>();
const eventTotals = new Map<string, number>();

for (const entry of entries) {
  if (entry.spans) {
    for (const span of entry.spans) {
      const existing = spanTotals.get(span.name);
      if (existing) {
        existing.count += span.count;
        existing.totalMs += span.totalMs;
        existing.maxMs = Math.max(existing.maxMs, span.maxMs);
      } else {
        spanTotals.set(span.name, {
          count: span.count,
          totalMs: span.totalMs,
          maxMs: span.maxMs,
        });
      }
    }
  }
  if (entry.events) {
    for (const [name, count] of Object.entries(entry.events)) {
      eventTotals.set(name, (eventTotals.get(name) ?? 0) + count);
    }
  }
}

const first = new Date(entries[0].ts).getTime();
const last = new Date(entries[entries.length - 1].ts).getTime();
const durationSec = Math.max(1, (last - first) / 1000);

const spansSorted = Array.from(spanTotals.entries()).sort((a, b) => b[1].totalMs - a[1].totalMs);
const eventsSorted = Array.from(eventTotals.entries()).sort((a, b) => b[1] - a[1]);

const nameWidth = Math.min(
  48,
  Math.max(8, ...spansSorted.map(([name]) => name.length)),
);

console.log("");
console.log(`TUI profile summary (${lines.length} samples, ${Math.round(durationSec)}s)`);
console.log("");
console.log(`${pad("Span", nameWidth)}  ${pad("count", 8)}  ${pad("total", 10)}  ${pad("avg", 10)}  ${pad("max", 10)}`);
for (const [name, stat] of spansSorted) {
  const avg = stat.totalMs / stat.count;
  console.log(
    `${pad(name, nameWidth)}  ${pad(String(stat.count), 8)}  ${pad(fmtMs(stat.totalMs), 10)}  ${pad(fmtMs(avg), 10)}  ${pad(fmtMs(stat.maxMs), 10)}`,
  );
}

console.log("");
console.log(`${pad("Event", nameWidth)}  ${pad("count", 8)}  ${pad("rate/s", 8)}`);
for (const [name, count] of eventsSorted) {
  const rate = Math.round((count / durationSec) * 100) / 100;
  console.log(`${pad(name, nameWidth)}  ${pad(String(count), 8)}  ${pad(String(rate), 8)}`);
}
console.log("");
