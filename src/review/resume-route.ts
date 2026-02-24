import type { SessionMetadata } from "../sessions/types.js";
import type { TaskFile } from "../tasks/types.js";
import { allTasksDone } from "../tasks/store.js";

export type ReviewResumeRoute =
  | { action: "generate-findings" }
  | { action: "resume-execution" }
  | { action: "phase-complete" }
  | { action: "not-reviewing" };

/**
 * Determine the correct resume route for a session in "reviewing" status.
 *
 * - No review tasks file → needs findings generation
 * - Tasks file exists, all done → phase complete
 * - Tasks file exists, not all done → resume task execution
 * - Any other status → not-reviewing (caller should handle elsewhere)
 */
export function determineReviewResumeRoute(
  status: SessionMetadata["status"],
  reviewTaskFile: TaskFile | null,
): ReviewResumeRoute {
  if (status !== "reviewing") {
    return { action: "not-reviewing" };
  }

  if (reviewTaskFile === null) {
    return { action: "generate-findings" };
  }

  if (allTasksDone(reviewTaskFile)) {
    return { action: "phase-complete" };
  }

  return { action: "resume-execution" };
}
