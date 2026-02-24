import { describe, test, expect } from "bun:test";
import { determineReviewResumeRoute } from "../review/resume-route.js";
import { makeTask, makeTaskFile } from "./helpers.js";

describe("determineReviewResumeRoute", () => {
  test("reviewing status with no tasks.json indicates findings generation", () => {
    const route = determineReviewResumeRoute("reviewing", null);
    expect(route.action).toBe("generate-findings");
  });

  test("reviewing status with incomplete tasks indicates execution resume", () => {
    const taskFile = makeTaskFile([
      makeTask({ id: "RVW-001", status: "done" }),
      makeTask({ id: "RVW-002", status: "open" }),
      makeTask({ id: "RVW-003", status: "failed" }),
    ]);
    const route = determineReviewResumeRoute("reviewing", taskFile);
    expect(route.action).toBe("resume-execution");
  });

  test("reviewing status with all tasks done indicates phase complete", () => {
    const taskFile = makeTaskFile([
      makeTask({ id: "RVW-001", status: "done" }),
      makeTask({ id: "RVW-002", status: "done" }),
      makeTask({ id: "RVW-003", status: "skipped" }),
    ]);
    const route = determineReviewResumeRoute("reviewing", taskFile);
    expect(route.action).toBe("phase-complete");
  });

  test("executing status with all tasks failed does NOT route to reviewing", () => {
    const taskFile = makeTaskFile([
      makeTask({ id: "US-001", status: "failed" }),
      makeTask({ id: "US-002", status: "failed" }),
    ]);
    const route = determineReviewResumeRoute("executing", taskFile);
    expect(route.action).toBe("not-reviewing");
  });

  test("non-reviewing statuses return not-reviewing regardless of task state", () => {
    for (const status of ["executing", "planning", "completed", "failed", "paused"] as const) {
      const route = determineReviewResumeRoute(status, null);
      expect(route.action).toBe("not-reviewing");
    }
  });
});
