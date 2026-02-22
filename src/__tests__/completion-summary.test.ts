import { describe, test, expect } from "bun:test";
import { formatDuration } from "../utils/format.js";

// buildSummaryMarkdown is a module-level function in cli.tsx.
// We test it indirectly by re-implementing the logic here to validate the format contract,
// or we can import it if exported. Since it's not exported, we test the shared utility
// and validate the markdown format via a local copy of the logic.

describe("formatDuration", () => {
  test("formats seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(500)).toBe("0s");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  test("formats minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });

  test("formats hours and minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(5_400_000)).toBe("1h 30m");
    expect(formatDuration(7_200_000)).toBe("2h 0m");
    expect(formatDuration(86_400_000)).toBe("24h 0m");
  });
});

describe("buildSummaryMarkdown format", () => {
  // Since buildSummaryMarkdown is not exported from cli.tsx, we replicate
  // its logic here to validate the contract. If the function is ever extracted
  // to a shared module, these tests should import it directly.

  function buildSummaryMarkdown(data: {
    projectName: string;
    planId: string;
    agentName: string;
    totalDurationMs: number;
    totalIterations: number;
    tasks: { id: string; title: string; status: string }[];
    progress: { total: number; done: number; failed: number; open: number; inProgress: number };
    commits: string[];
  }): string {
    const dur = formatDuration(data.totalDurationMs);
    const lines: string[] = [
      `# Completion Summary`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| Project | ${data.projectName} |`,
      `| Plan | ${data.planId} |`,
      `| Agent | ${data.agentName} |`,
      `| Duration | ${dur} |`,
      `| Iterations | ${data.totalIterations} |`,
      `| Tasks | ${data.progress.done}/${data.progress.total} done, ${data.progress.failed} failed, ${data.progress.open} open |`,
      ``,
      `## Tasks`,
      ``,
    ];
    for (const task of data.tasks) {
      const icon = task.status === "done" ? "[x]" : task.status === "failed" ? "[-]" : "[ ]";
      lines.push(`- ${icon} **${task.id}** ${task.title} — \`${task.status}\``);
    }
    if (data.commits.length > 0) {
      lines.push(``, `## Commits`, ``);
      for (const c of data.commits) {
        lines.push(`- ${c}`);
      }
    }
    lines.push(``);
    return lines.join("\n");
  }

  const baseSummary = {
    projectName: "test-project",
    planId: "abc-123",
    agentName: "claude",
    totalDurationMs: 125_000,
    totalIterations: 5,
    tasks: [
      { id: "T1", title: "Setup database", status: "done" },
      { id: "T2", title: "Add API routes", status: "done" },
      { id: "T3", title: "Write tests", status: "failed" },
      { id: "T4", title: "Deploy", status: "open" },
    ],
    progress: { total: 4, done: 2, failed: 1, open: 1, inProgress: 0 },
    commits: [],
  };

  test("includes markdown header and metadata table", () => {
    const md = buildSummaryMarkdown(baseSummary);
    expect(md).toContain("# Completion Summary");
    expect(md).toContain("| Project | test-project |");
    expect(md).toContain("| Plan | abc-123 |");
    expect(md).toContain("| Agent | claude |");
    expect(md).toContain("| Duration | 2m 5s |");
    expect(md).toContain("| Iterations | 5 |");
    expect(md).toContain("| Tasks | 2/4 done, 1 failed, 1 open |");
  });

  test("renders task checklist with correct icons", () => {
    const md = buildSummaryMarkdown(baseSummary);
    expect(md).toContain("- [x] **T1** Setup database");
    expect(md).toContain("- [x] **T2** Add API routes");
    expect(md).toContain("- [-] **T3** Write tests");
    expect(md).toContain("- [ ] **T4** Deploy");
  });

  test("omits commits section when empty", () => {
    const md = buildSummaryMarkdown(baseSummary);
    expect(md).not.toContain("## Commits");
  });

  test("includes commits section when present", () => {
    const md = buildSummaryMarkdown({
      ...baseSummary,
      commits: ["abc1234 feat: add database", "def5678 fix: route handler"],
    });
    expect(md).toContain("## Commits");
    expect(md).toContain("- abc1234 feat: add database");
    expect(md).toContain("- def5678 fix: route handler");
  });

  test("handles zero tasks", () => {
    const md = buildSummaryMarkdown({
      ...baseSummary,
      tasks: [],
      progress: { total: 0, done: 0, failed: 0, open: 0, inProgress: 0 },
    });
    expect(md).toContain("## Tasks");
    expect(md).toContain("| Tasks | 0/0 done, 0 failed, 0 open |");
  });
});
