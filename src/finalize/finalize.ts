import type { SynthConfig } from "../config/types.js";
import type { AgentAdapter } from "../agents/types.js";
import type { SessionPaths } from "../sessions/types.js";
import { loadTasks } from "../tasks/store.js";
import { selfReview, type ReviewFinding } from "./review.js";
import { runFormatters } from "./formatter.js";
import { analyzeAndSplit, splitCommit } from "./splitter.js";
import { createPr, generatePrBody, getDiffStats } from "./pr.js";
import { prdAudit, formatAuditReport, type AuditResult } from "./audit.js";
import { spawn } from "../utils/process.js";
import { fileExists, readText } from "../utils/fs.js";
import { getCurrentBranch, getSessionDiff } from "../utils/git.js";
import { getSessionSlug } from "../sessions/slug.js";

export interface FinalizeResult {
  findings: ReviewFinding[];
  audit: AuditResult | null;
  formatted: boolean;
  commitCount: number;
  prUrl: string | null;
  blocked: boolean;
  blockReason?: string;
}

export async function finalize(
  config: SynthConfig,
  agent: AgentAdapter,
  sessionPaths: SessionPaths,
  cwd: string,
): Promise<FinalizeResult> {
  const taskFile = await loadTasks(sessionPaths.tasks);
  let findings: ReviewFinding[] = [];
  let formatted = false;
  let commitCount = 0;

  const slug = await getSessionSlug(sessionPaths);
  const { diff: sessionDiff } = await getSessionDiff(cwd, config.project.base_branch, slug);

  // 1. Self-review
  if (config.finalize.self_review) {
    if (sessionDiff.trim()) {
      findings = await selfReview(agent, sessionDiff, cwd, config.agent.model);

      // Check for critical findings
      const criticals = findings.filter((f) => f.severity === "critical");
      if (criticals.length > 0) {
        return {
          findings,
          audit: null,
          formatted: false,
          commitCount: 0,
          prUrl: null,
          blocked: true,
          blockReason: `Critical findings: ${criticals.map((c) => c.message).join("; ")}`,
        };
      }
    }
  }

  // 2. PRD audit
  let audit: AuditResult | null = null;
  const prdExists = await fileExists(sessionPaths.prd);
  const prdContent = prdExists ? await readText(sessionPaths.prd) : null;
  if (prdContent) {
    if (sessionDiff.trim()) {
      audit = await prdAudit(agent, prdContent, sessionDiff, cwd, config.agent.model);

      // Display audit results
      console.log("\n" + formatAuditReport(audit));

      if (audit.overall === "fail") {
        return {
          findings,
          audit,
          formatted: false,
          commitCount: 0,
          prUrl: null,
          blocked: true,
          blockReason: `PRD audit failed: ${audit.summary}`,
        };
      }
    }
  }

  // 3. Auto-format (was step 2)
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

  // 4. Split commits (if not already committed atomically by engine)
  if (config.finalize.split_commits) {
    const addHandle = spawn({ cmd: ["git", "add", "-A"], cwd });
    await addHandle.promise;

    const groups = await analyzeAndSplit(cwd, taskFile.description);
    if (groups.length > 1) {
      await splitCommit(cwd, groups);
      commitCount += groups.length;
    }
  }

  // 5. Create PR (skip if on base branch)
  let prUrl: string | null = null;
  if (config.finalize.create_pr) {
    const branch = await getCurrentBranch(cwd);
    if (branch === config.project.base_branch) {
      console.log(`Skipping PR creation: already on base branch '${branch}'`);
    } else {
      const diffStats = await getDiffStats(cwd, config.project.base_branch);
      const body = generatePrBody(
        taskFile,
        prdContent,
        findings,
        diffStats,
        audit,
      );

      const title = taskFile.description || config.project.name;
      try {
        const result = await createPr(cwd, branch, title, body);
        prUrl = result.url;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`PR creation failed: ${msg}`);
        console.error("Continuing with remaining finalize steps.");
      }
    }
  }

  return {
    findings,
    audit,
    formatted,
    commitCount,
    prUrl,
    blocked: false,
  };
}
