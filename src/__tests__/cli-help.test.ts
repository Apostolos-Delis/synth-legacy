import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../cli.tsx");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(...args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Merge stdout + stderr so we catch help regardless of where yargs writes it. */
function output(r: RunResult): string {
  return r.stdout + r.stderr;
}

// ── Top-level help ──────────────────────────────────────────────────────────

describe("top-level help", () => {
  test("--help exits 0 and lists all commands", async () => {
    const r = await run("--help");
    expect(r.exitCode).toBe(0);
    const out = output(r);

    // All 14 commands appear
    for (const cmd of [
      "start",
      "resume",
      "ls",
      "show",
      "status",
      "config",
      "doctor",
      "themes",
      "ps",
      "rm",
      "clean",
      "update",
      "version",
      "init",
    ]) {
      expect(out).toContain(cmd);
    }
  });

  test("contains Commands section", async () => {
    const r = await run("--help");
    const out = output(r);
    expect(out).toContain("Commands:");
  });

  test("contains Global Options section", async () => {
    const r = await run("--help");
    const out = output(r);
    expect(out).toContain("Global Options:");
  });
});

// ── Per-command help ────────────────────────────────────────────────────────

/** Commands and the content we expect in their --help output. */
const commandExpectations: Record<
  string,
  { descSnippet: string; hasExamples: boolean }
> = {
  start: {
    descSnippet: "Start a new session",
    hasExamples: false,
  },
  resume: {
    descSnippet: "Resume a paused or interrupted session",
    hasExamples: false,
  },
  ls: {
    descSnippet: "List sessions",
    hasExamples: false,
  },
  show: {
    descSnippet: "Show session details",
    hasExamples: false,
  },
  status: {
    descSnippet: "Show session progress status",
    hasExamples: true,
  },
  ps: {
    descSnippet: "List running synth instances",
    hasExamples: false,
  },
  config: {
    descSnippet: "Display or edit configuration",
    hasExamples: true,
  },
  doctor: {
    descSnippet: "Validate environment setup",
    hasExamples: false,
  },
  themes: {
    descSnippet: "List available themes",
    hasExamples: false,
  },
  init: {
    descSnippet: "Create a synth.toml",
    hasExamples: true,
  },
  rm: {
    descSnippet: "Remove sessions",
    hasExamples: true,
  },
  clean: {
    descSnippet: "Remove stale sessions",
    hasExamples: false,
  },
  update: {
    descSnippet: "Update synth to the latest version",
    hasExamples: false,
  },
  version: {
    descSnippet: "Show synth version",
    hasExamples: false,
  },
};

describe("per-command help", () => {
  for (const [cmd, expectations] of Object.entries(commandExpectations)) {
    describe(cmd, () => {
      test("--help exits 0", async () => {
        const r = await run(cmd, "--help");
        expect(r.exitCode).toBe(0);
      });

      test("output contains command name and description", async () => {
        const r = await run(cmd, "--help");
        const out = output(r);
        expect(out).toContain(cmd);
        expect(out).toContain(expectations.descSnippet);
      });

      test("output contains at least one option or positional", async () => {
        const r = await run(cmd, "--help");
        const out = output(r);
        // Every command at minimum has --help and --version options
        expect(out).toContain("--help");
      });

      if (expectations.hasExamples) {
        test("output contains examples", async () => {
          const r = await run(cmd, "--help");
          const out = output(r);
          expect(out).toContain("Examples:");
        });
      }
    });
  }
});

// ── Unknown command ─────────────────────────────────────────────────────────

describe("unknown command", () => {
  test("exits non-zero with error message", async () => {
    const r = await run("foobar");
    expect(r.exitCode).not.toBe(0);
    const out = output(r);
    expect(out).toMatch(/unknown command/i);
  });
});

// ── -h alias ────────────────────────────────────────────────────────────────

describe("-h alias", () => {
  test("synth start -h matches synth start --help", async () => {
    const [short, long] = await Promise.all([
      run("start", "-h"),
      run("start", "--help"),
    ]);
    expect(short.exitCode).toBe(0);
    expect(output(short)).toEqual(output(long));
  });
});
