import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { runDoctorChecks, checkCommand, parseVersion } from "../doctor/doctor.js";
import type { SynthConfig } from "../config/types.js";
import { writeText, ensureDir } from "../utils/fs.js";

// ── parseVersion unit tests ───────────────────────────────────────────

describe("parseVersion", () => {
  test("parses semver string", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
  });

  test("parses major.minor without patch", () => {
    expect(parseVersion("2.5")).toEqual([2, 5, 0]);
  });

  test("parses version embedded in string", () => {
    expect(parseVersion("bun 1.1.38")).toEqual([1, 1, 38]);
  });

  test("returns [0,0,0] for non-version string", () => {
    expect(parseVersion("no version here")).toEqual([0, 0, 0]);
  });

  test("returns [0,0,0] for empty string", () => {
    expect(parseVersion("")).toEqual([0, 0, 0]);
  });
});

// ── checkCommand unit tests ───────────────────────────────────────────

describe("checkCommand", () => {
  test("returns available=true for a real command", async () => {
    const result = await checkCommand("echo", ["hello"]);
    expect(result.available).toBe(true);
  });

  test("returns available=false for nonexistent command", async () => {
    const result = await checkCommand("definitely-not-a-real-command-xyz", ["--version"]);
    expect(result.available).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("captures version from stdout", async () => {
    const result = await checkCommand("echo", ["1.2.3"]);
    expect(result.version).toBe("1.2.3");
  });
});

// ── runDoctorChecks integration tests ─────────────────────────────────

describe("runDoctorChecks", () => {
  test("returns array of check results", async () => {
    const results = await runDoctorChecks(process.cwd());
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  test("each result has required fields", async () => {
    const results = await runDoctorChecks(process.cwd());
    for (const r of results) {
      expect(r.name).toBeDefined();
      expect(["pass", "fail", "warn"]).toContain(r.status);
    }
  });

  test("bun check passes in test environment", async () => {
    const results = await runDoctorChecks(process.cwd());
    const bunCheck = results.find((r) => r.name === "bun");
    expect(bunCheck).toBeDefined();
    expect(bunCheck!.status).toBe("pass");
  });

  test("git check passes in git repo", async () => {
    const results = await runDoctorChecks(process.cwd());
    const gitCheck = results.find((r) => r.name === "git");
    expect(gitCheck).toBeDefined();
    expect(gitCheck!.status).toBe("pass");
  });

  test("git repo check warns outside a git repo", async () => {
    const results = await runDoctorChecks("/tmp");
    const repoCheck = results.find((r) => r.name === "git repo");
    expect(repoCheck).toBeDefined();
    expect(repoCheck!.status).toBe("warn");
  });

  test("config check warns when synth.toml missing", async () => {
    const results = await runDoctorChecks("/tmp");
    const configCheck = results.find((r) => r.name === "synth.toml");
    expect(configCheck).toBeDefined();
    expect(configCheck!.status).toBe("warn");
    expect(configCheck!.suggestion).toContain("synth init");
  });

  test("config check fails with invalid TOML", async () => {
    const tmpDir = join("/tmp", `synth-doctor-test-${Date.now()}`);
    await ensureDir(tmpDir);
    await writeText(join(tmpDir, "synth.toml"), "invalid [[ toml content ===");
    try {
      const results = await runDoctorChecks(tmpDir);
      const configCheck = results.find((r) => r.name === "synth.toml");
      expect(configCheck).toBeDefined();
      expect(configCheck!.status).toBe("fail");
      expect(configCheck!.message).toContain("parse error");
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir]).exited;
    }
  });

  test("config check passes with valid TOML", async () => {
    const tmpDir = join("/tmp", `synth-doctor-test-${Date.now()}`);
    await ensureDir(tmpDir);
    await writeText(join(tmpDir, "synth.toml"), '[project]\nname = "test"\n');
    try {
      const results = await runDoctorChecks(tmpDir);
      const configCheck = results.find((r) => r.name === "synth.toml");
      expect(configCheck).toBeDefined();
      expect(configCheck!.status).toBe("pass");
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir]).exited;
    }
  });

  test("failed checks include suggestions", async () => {
    const results = await runDoctorChecks("/tmp");
    const failures = results.filter((r) => r.status === "fail" || r.status === "warn");
    for (const f of failures) {
      if (f.suggestion) {
        expect(typeof f.suggestion).toBe("string");
        expect(f.suggestion.length).toBeGreaterThan(0);
      }
    }
  });

  test("gh check is skipped when config has no create_pr", async () => {
    const results = await runDoctorChecks(process.cwd());
    const ghCheck = results.find((r) => r.name === "gh CLI");
    expect(ghCheck).toBeUndefined();
  });

  test("gh check runs when config has create_pr=true", async () => {
    const config = { finalize: { create_pr: true } } as Partial<SynthConfig> as SynthConfig;
    const results = await runDoctorChecks(process.cwd(), config);
    const ghCheck = results.find((r) => r.name === "gh CLI");
    expect(ghCheck).toBeDefined();
  });

  test("agent auth checks are included when agents are found", async () => {
    const results = await runDoctorChecks(process.cwd());
    const agentFound = results.some((r) => r.name.endsWith("CLI") && r.status === "pass");
    if (agentFound) {
      const authChecks = results.filter((r) => r.name.includes("auth"));
      expect(authChecks.length).toBeGreaterThan(0);
    }
  });

  test("backpressure checks run when configured", async () => {
    const config = {
      guardrails: { backpressure_commands: ["echo test"], max_consecutive_failures: 3 },
    } as Partial<SynthConfig> as SynthConfig;
    const results = await runDoctorChecks(process.cwd(), config);
    const bpCheck = results.find((r) => r.name.startsWith("backpressure:"));
    expect(bpCheck).toBeDefined();
    expect(bpCheck!.status).toBe("pass");
  });

  test("backpressure warns for missing binary", async () => {
    const config = {
      guardrails: { backpressure_commands: ["nonexistent-binary-xyz check"], max_consecutive_failures: 3 },
    } as Partial<SynthConfig> as SynthConfig;
    const results = await runDoctorChecks(process.cwd(), config);
    const bpCheck = results.find((r) => r.name === "backpressure: nonexistent-binary-xyz");
    expect(bpCheck).toBeDefined();
    expect(bpCheck!.status).toBe("warn");
  });
});
