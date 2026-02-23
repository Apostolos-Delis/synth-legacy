import type { SynthConfig } from "../config/types.js";
import type { AgentAdapter } from "../agents/types.js";
import type { PlanPaths } from "../plans/types.js";
import { loadTasks } from "../tasks/store.js";
import { selfReview, type ReviewFinding } from "./review.js";
import { runFormatters } from "./formatter.js";
import { analyzeAndSplit, splitCommit } from "./splitter.js";
import { createPr, generatePrBody, getDiffStats } from "./pr.js";
import { spawn } from "../utils/process.js";
import { fileExists, readText } from "../utils/fs.js";
import { getCurrentBranch } from "../utils/git.js";

export interface FinalizeResult {
  findings: ReviewFinding[];
  formatted: boolean;
  commitCount: number;
  prUrl: string | null;
  blocked: boolean;
  blockReason?: string;
}

export async function finalize(
  config: SynthConfig,
  agent: AgentAdapter,
  planPaths: PlanPaths,
  cwd: string,
): Promise<FinalizeResult> {
  const taskFile = await loadTasks(planPaths.tasks);
  let findings: ReviewFinding[] = [];
  let formatted = false;
  let commitCount = 0;

  // 1. Self-review
  if (config.finalize.self_review) {
    const diffHandle = spawn({
      cmd: ["git", "diff", `${config.project.base_branch}...HEAD`],
      cwd,
    });
    const diffResult = await diffHandle.promise;

    if (diffResult.stdout.trim()) {
      findings = await selfReview(agent, diffResult.stdout, cwd, config.agent.model);

      // Check for critical findings
      const criticals = findings.filter((f) => f.severity === "critical");
      if (criticals.length > 0) {
        return {
          findings,
          formatted: false,
          commitCount: 0,
          prUrl: null,
          blocked: true,
          blockReason: `Critical findings: ${criticals.map((c) => c.message).join("; ")}`,
        };
      }
    }
  }

  // 2. Auto-format
  if (config.finalize.auto_format) {
    const formatResults = await runFormatters(cwd);
    formatted = formatResults.some((r) => r.success);

    if (formatted) {
      // Stage and commit formatting changes
      const addHandle = spawn({ cmd: ["git", "add", "-A"], cwd });
      await addHandle.promise;

      const hasChanges = spawn({ cmd: ["git", "diff", "--cached", "--quiet"], cwd });
      const changesResult = await hasChanges.promise;
      if (changesResult.exitCode !== 0) {
        const commitHandle = spawn({
          cmd: ["git", "commit", "-m", "style: auto-format"],
          cwd,
        });
        await commitHandle.promise;
        commitCount++;
      }
    }
  }

  // 3. Split commits (if not already committed atomically by engine)
  if (config.finalize.split_commits) {
    const addHandle = spawn({ cmd: ["git", "add", "-A"], cwd });
    await addHandle.promise;

    const groups = await analyzeAndSplit(cwd, taskFile.description);
    if (groups.length > 1) {
      await splitCommit(cwd, groups);
      commitCount += groups.length;
    }
  }

  // 4. Create PR
  let prUrl: string | null = null;
  if (config.finalize.create_pr) {
    const prdContent = (await fileExists(planPaths.prd))
      ? await readText(planPaths.prd)
      : null;
    const diffStats = await getDiffStats(cwd, config.project.base_branch);
    const body = generatePrBody(
      taskFile,
      prdContent,
      findings,
      diffStats,
    );

    const title = taskFile.description || config.project.name;
    const branch = await getCurrentBranch(cwd);
    const result = await createPr(cwd, branch, title, body);
    prUrl = result.url;
  }

  return {
    findings,
    formatted,
    commitCount,
    prUrl,
    blocked: false,
  };
}
