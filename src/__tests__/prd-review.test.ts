import { describe, expect, test } from "bun:test";
import { buildRevisionPrompt, extractMarkdownPrd } from "../engine/prd-review.js";

describe("buildRevisionPrompt", () => {
  test("includes current PRD and feedback", () => {
    const prompt = buildRevisionPrompt("# PRD\n\nOld", "Add metrics section.");
    expect(prompt).toContain("# PRD");
    expect(prompt).toContain("Add metrics section.");
  });

  test("instructs markdown code block output", () => {
    const prompt = buildRevisionPrompt("# PRD", "Update goals.");
    expect(prompt).toContain("```markdown");
    expect(prompt).toContain("Only output the revised PRD in the code block.");
  });
});

describe("extractMarkdownPrd", () => {
  test("extracts markdown inside fenced code block", () => {
    const output = "Here you go:\n\n```markdown\n# New PRD\n\n## Goals\n- A\n```\n\nThanks.";
    expect(extractMarkdownPrd(output)).toBe("# New PRD\n\n## Goals\n- A");
  });

  test("returns null when no markdown code block exists", () => {
    const output = "# New PRD\n\nNo fence.";
    expect(extractMarkdownPrd(output)).toBeNull();
  });
});
