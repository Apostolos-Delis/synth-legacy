import { describe, test, expect } from "bun:test";
import { parseWorktreeFlag } from "../cli.js";

describe("parseWorktreeFlag", () => {
  test("returns false when no -w or --worktree flag", () => {
    expect(parseWorktreeFlag(["start", "--prd", "spec.md"])).toEqual({
      useWorktree: false,
    });
  });

  test("returns false for empty args", () => {
    expect(parseWorktreeFlag([])).toEqual({ useWorktree: false });
  });

  test("parses -w with explicit name", () => {
    expect(parseWorktreeFlag(["start", "-w", "my-feature"])).toEqual({
      useWorktree: true,
      explicitName: "my-feature",
    });
  });

  test("parses --worktree with explicit name", () => {
    expect(parseWorktreeFlag(["start", "--worktree", "my-feature"])).toEqual({
      useWorktree: true,
      explicitName: "my-feature",
    });
  });

  test("parses -w without name (auto-generate)", () => {
    expect(parseWorktreeFlag(["start", "-w"])).toEqual({
      useWorktree: true,
    });
  });

  test("parses --worktree without name", () => {
    expect(parseWorktreeFlag(["start", "--worktree"])).toEqual({
      useWorktree: true,
    });
  });

  test("does not treat next flag as worktree name", () => {
    expect(parseWorktreeFlag(["start", "-w", "--prd", "spec.md"])).toEqual({
      useWorktree: true,
    });
  });

  test("works with -w before --prd", () => {
    expect(
      parseWorktreeFlag(["start", "-w", "feat", "--prd", "spec.md"]),
    ).toEqual({
      useWorktree: true,
      explicitName: "feat",
    });
  });

  test("works with --prd before -w", () => {
    expect(
      parseWorktreeFlag(["start", "--prd", "spec.md", "-w", "feat"]),
    ).toEqual({
      useWorktree: true,
      explicitName: "feat",
    });
  });

  test("prefers -w over --worktree when both present", () => {
    expect(
      parseWorktreeFlag(["start", "-w", "short", "--worktree", "long"]),
    ).toEqual({
      useWorktree: true,
      explicitName: "short",
    });
  });
});
