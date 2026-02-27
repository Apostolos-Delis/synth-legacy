import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { CompletionSummary, ReviewStatus } from "./types.js";
import { boldAttr, colors, statusIndicators, STATUS_COLORS_HEX } from "./theme.js";
import { Footer } from "./components/Footer.js";
import { stripAnsi } from "./utils.js";
import { formatDuration } from "../utils/format.js";
import { startSpan, endSpan } from "./profiler.js";

interface CompletionViewProps {
  summary: CompletionSummary;
  showFinalizePrompt?: boolean;
  showReviewPrompt?: boolean;
  reviewStatus?: ReviewStatus;
}

function padLine(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

function padRight(text: string, width: number): string {
  if (width <= 0 || text.length >= width) return "";
  return " ".repeat(width - text.length);
}

function normalizeCommitSubject(subject: string): string {
  return stripAnsi(subject)
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, maxWidth);
  return text.slice(0, maxWidth - 3) + "...";
}

export function CompletionView({ summary, showFinalizePrompt, showReviewPrompt, reviewStatus }: CompletionViewProps): ReactNode {
  const renderSpan = startSpan("CompletionView");
  const { width, height } = useTerminalDimensions();
  const { progress, tasks, commits } = summary;
  const showReviewFixes = typeof summary.reviewFixesApplied === "number";
  const innerWidth = Math.max(1, width - 2);
  const headerText = `Completion Summary | ${summary.projectName} (${summary.sessionId})`;
  const headerPad = padRight(headerText, innerWidth);
  const statsText = `Duration: ${formatDuration(summary.totalDurationMs)}  Iterations: ${summary.totalIterations}  Agent: ${summary.agentName}`;
  const statsPad = padRight(statsText, innerWidth);
  const doneIcon = statusIndicators.done ?? "\u2713";
  const failedIcon = statusIndicators.failed ?? "\u2717";
  const openIcon = statusIndicators.open ?? "\u25CB";
  const inProgressIcon = statusIndicators.in_progress ?? "\u25D0";
  const fullProgressText = `${doneIcon} ${progress.done} done  ${failedIcon} ${progress.failed} failed  ${openIcon} ${progress.open} open  ${inProgressIcon} ${progress.inProgress} in progress`;
  const compactProgressText = `${doneIcon} ${progress.done}  ${failedIcon} ${progress.failed}  ${openIcon} ${progress.open}  ${inProgressIcon} ${progress.inProgress}`;
  const useCompactProgress = fullProgressText.length > innerWidth;
  const progressText = useCompactProgress ? compactProgressText : fullProgressText;
  const progressPad = padRight(progressText, innerWidth);
  const progressSeparator = "  ";
  const tableHeaderText = `${"ID".padEnd(8)} ${"Title".padEnd(40)} Status`;
  const tableHeaderPad = padRight(tableHeaderText, innerWidth);
  const summaryText = `Summary saved to: ${summary.summaryFilePath}`;
  const summaryPad = padRight(summaryText, innerWidth);
  const blankLine = padLine("", innerWidth);
  const reviewStatusRow = showReviewPrompt ? 1 : 0;
  const reviewFixesRow = showReviewFixes ? 1 : 0;
  const promptRow = showFinalizePrompt || showReviewPrompt ? 1 : 0;
  const reservedRows = 1 + 1 + 1 + reviewFixesRow + 1 + 1 + reviewStatusRow + promptRow + 1;
  const scrollHeight = Math.max(1, height - reservedRows);
  const reviewStatusText = reviewStatus === "running"
    ? "Review in progress..."
    : reviewStatus === "ready"
      ? "Review ready."
      : reviewStatus === "error"
        ? "Review failed."
        : null;

  const commitRows: ReactNode[] = [];
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const firstSpace = commit.indexOf(" ");
    const hash = firstSpace === -1 ? commit : commit.slice(0, firstSpace);
    const subject = firstSpace === -1 ? "" : commit.slice(firstSpace + 1);
    const indent = innerWidth >= 2 ? "  " : "";
    const maxHashWidth = Math.max(0, innerWidth - indent.length);
    const displayHash = maxHashWidth > 0 ? hash.slice(0, maxHashWidth) : "";
    const cleanedSubject = normalizeCommitSubject(subject);
    const subjectWidth = Math.max(0, innerWidth - indent.length - displayHash.length - (cleanedSubject ? 1 : 0));
    const displaySubject = cleanedSubject ? truncateText(cleanedSubject, subjectWidth) : "";
    const rowText = `${indent}${displayHash}${displaySubject ? ` ${displaySubject}` : ""}`;
    const rowPad = padRight(rowText, innerWidth);

    commitRows.push(
      <text key={`commit-${i}`} truncate={true}>
        <span fg={colors.fg.secondary}>{indent}{displayHash}</span>
        {displaySubject ? <span fg={colors.fg.muted}>{" "}</span> : null}
        {displaySubject ? <span fg={colors.fg.primary}>{displaySubject}</span> : null}
        <span>{rowPad}</span>
      </text>,
    );
  }

  endSpan("CompletionView", renderSpan);
  return (
    <box width={width} height={height} flexDirection="column">
      {/* Header */}
      <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text truncate={true}>
          <span fg={colors.status.success} attributes={boldAttr()}>Completion Summary</span>
          <span fg={colors.fg.muted}>{" | "}</span>
          <span fg={colors.fg.secondary}>{summary.projectName}</span>
          <span fg={colors.fg.muted}>{" ("}</span>
          <span fg={colors.accent.primary}>{summary.sessionId}</span>
          <span fg={colors.fg.muted}>{")"}</span>
          <span>{headerPad}</span>
        </text>
      </box>

      {/* Stats line */}
      <box style={{ paddingLeft: 1 }}>
        <text truncate={true}>
          <span fg={colors.fg.muted}>{"Duration: "}</span>
          <span fg={colors.fg.primary} attributes={boldAttr()}>{formatDuration(summary.totalDurationMs)}</span>
          <span fg={colors.fg.muted}>{"  Iterations: "}</span>
          <span fg={colors.fg.primary} attributes={boldAttr()}>{String(summary.totalIterations)}</span>
          <span fg={colors.fg.muted}>{"  Agent: "}</span>
          <span fg={colors.fg.secondary}>{summary.agentName}</span>
          <span>{statsPad}</span>
        </text>
      </box>

      {/* Progress line */}
      <box style={{ paddingLeft: 1 }}>
        <text truncate={true}>
          <span fg={STATUS_COLORS_HEX.done ?? colors.status.success}>
            {doneIcon}{" "}{String(progress.done)}{useCompactProgress ? "" : " done"}
          </span>
          <span>{progressSeparator}</span>
          <span fg={STATUS_COLORS_HEX.failed ?? colors.status.error}>
            {failedIcon}{" "}{String(progress.failed)}{useCompactProgress ? "" : " failed"}
          </span>
          <span>{progressSeparator}</span>
          <span fg={STATUS_COLORS_HEX.open ?? colors.fg.muted}>
            {openIcon}{" "}{String(progress.open)}{useCompactProgress ? "" : " open"}
          </span>
          <span>{progressSeparator}</span>
          <span fg={STATUS_COLORS_HEX.in_progress ?? colors.accent.primary}>
            {inProgressIcon}{" "}{String(progress.inProgress)}{useCompactProgress ? "" : " in progress"}
          </span>
          <span>{progressPad}</span>
        </text>
      </box>
      {showReviewFixes && (
        <box style={{ paddingLeft: 1 }}>
          <text truncate={true}>
            <span fg={colors.fg.muted}>{"Review fixes applied: "}</span>
            <span fg={colors.fg.primary} attributes={boldAttr()}>{String(summary.reviewFixesApplied)}</span>
          </text>
        </box>
      )}

      {/* Separator */}
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.border.normal}>{"\u2500".repeat(Math.min(width - 2, 80))}</span>
        </text>
      </box>

      {/* Task table header */}
      <box style={{ paddingLeft: 1 }}>
        <text truncate={true}>
          <span fg={colors.fg.muted} attributes={boldAttr()}>
            {"ID".padEnd(8)} {"Title".padEnd(40)} Status
          </span>
          <span>{tableHeaderPad}</span>
        </text>
      </box>

      {/* Task list */}
      <scrollbox height={scrollHeight} stickyScroll={true} stickyStart="top" style={{ flexDirection: "column", paddingLeft: 1 }}>
        {tasks.map((task) => {
          const icon = statusIndicators[task.status] ?? "?";
          const statusColor = STATUS_COLORS_HEX[task.status] ?? colors.fg.muted;
          const title =
            task.title.length > 40
              ? task.title.slice(0, 37) + "..."
              : task.title.padEnd(40);

          return (
            <text key={task.id}>
              <span fg={colors.fg.secondary}>{task.id.padEnd(8)}</span>
              {" "}
              <span fg={colors.fg.primary}>{title}</span>
              {" "}
              <span fg={statusColor}>{icon} {task.status}</span>
            </text>
          );
        })}

        {/* Separator before commits */}
        {commits.length > 0 && (
          <>
            <text>
              <span>{blankLine}</span>
            </text>
            <text>
              <span fg={colors.border.normal}>{"\u2500".repeat(Math.min(width - 2, 80))}</span>
            </text>
            <text>
              <span fg={colors.fg.muted} attributes={boldAttr()}>Commits ({String(commits.length)})</span>
            </text>
            {commitRows}
          </>
        )}

        {/* Summary file path */}
        <text>
          <span>{blankLine}</span>
        </text>
        <text>
          <span fg={colors.fg.muted}>{"Summary saved to: "}</span>
          <span fg={colors.accent.primary}>{summary.summaryFilePath}</span>
          <span>{summaryPad}</span>
        </text>
      </scrollbox>

      {showReviewPrompt && reviewStatusText && (
        <box style={{ paddingLeft: 1 }}>
          <text>
            <span fg={colors.fg.muted}>{reviewStatusText}</span>
          </text>
        </box>
      )}

      {showReviewPrompt && (
        <box style={{ paddingLeft: 1 }}>
          <text>
            <span fg={colors.status.success} attributes={boldAttr()}>
              {"All tasks complete. "}
            </span>
            <span fg={colors.fg.secondary}>
              {"Press "}
            </span>
            <span fg={colors.accent.primary} attributes={boldAttr()}>Enter</span>
            <span fg={colors.fg.secondary}>
              {" to start review, or "}
            </span>
            <span fg={colors.accent.primary} attributes={boldAttr()}>q</span>
            <span fg={colors.fg.secondary}>{" to exit."}</span>
          </text>
        </box>
      )}

      {showFinalizePrompt && (
        <box style={{ paddingLeft: 1 }}>
          <text>
            <span fg={colors.status.success} attributes={boldAttr()}>
              {"All tasks complete. "}
            </span>
            <span fg={colors.fg.secondary}>
              {"Press "}
            </span>
            <span fg={colors.accent.primary} attributes={boldAttr()}>Enter</span>
            <span fg={colors.fg.secondary}>
              {" to finalize, or "}
            </span>
            <span fg={colors.accent.primary} attributes={boldAttr()}>q</span>
            <span fg={colors.fg.secondary}>{" to exit."}</span>
          </text>
        </box>
      )}

      <Footer
        view={showReviewPrompt ? "completion-review" : showFinalizePrompt ? "completion-finalize" : "completion"}
        width={width}
      />
    </box>
  );
}
