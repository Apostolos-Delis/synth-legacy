import { describe, test, expect } from "bun:test";
import { buildClaudeCmd } from "../agents/claude.js";
import { buildCodexCmd } from "../agents/codex.js";

describe("buildClaudeCmd", () => {
  test("includes --tools with read-only tools when readOnly is true", () => {
    const cmd = buildClaudeCmd("test prompt", { readOnly: true });
    expect(cmd).toContain("--tools");
    const idx = cmd.indexOf("--tools");
    expect(cmd[idx + 1]).toBe("Read,Glob,Grep");
  });

  test("omits --tools when readOnly is false", () => {
    const cmd = buildClaudeCmd("test prompt", { readOnly: false });
    expect(cmd).not.toContain("--tools");
  });

  test("omits --tools when readOnly is not set", () => {
    const cmd = buildClaudeCmd("test prompt", {});
    expect(cmd).not.toContain("--tools");
  });

  test("includes both --model and --tools when both are set", () => {
    const cmd = buildClaudeCmd("test prompt", {
      model: "sonnet",
      readOnly: true,
    });
    expect(cmd).toContain("--model");
    expect(cmd).toContain("--tools");
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("sonnet");
    expect(cmd[cmd.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
  });
});

describe("buildCodexCmd", () => {
  test("includes --sandbox read-only when readOnly is true", () => {
    const cmd = buildCodexCmd("test prompt", { readOnly: true });
    expect(cmd).toContain("--sandbox");
    const idx = cmd.indexOf("--sandbox");
    expect(cmd[idx + 1]).toBe("read-only");
  });

  test("omits --sandbox when readOnly is false", () => {
    const cmd = buildCodexCmd("test prompt", { readOnly: false });
    expect(cmd).not.toContain("--sandbox");
  });

  test("omits --sandbox when readOnly is not set", () => {
    const cmd = buildCodexCmd("test prompt", {});
    expect(cmd).not.toContain("--sandbox");
  });

  test("prompt is always the last argument", () => {
    const cmd = buildCodexCmd("my prompt", { readOnly: true });
    expect(cmd[cmd.length - 1]).toBe("my prompt");
  });
});
