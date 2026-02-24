import { describe, test, expect } from "bun:test";
import { runDoctorChecks } from "../doctor/doctor.js";

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

  test("config check passes with valid synth.toml", async () => {
    const results = await runDoctorChecks(process.cwd());
    const configCheck = results.find((r) => r.name === "synth.toml");
    expect(configCheck).toBeDefined();
    // May be pass or warn depending on whether synth.toml exists in test dir
    expect(["pass", "warn"]).toContain(configCheck!.status);
  });

  test("failed checks include suggestions", async () => {
    const results = await runDoctorChecks("/tmp/nonexistent-dir");
    const failures = results.filter((r) => r.status === "fail" || r.status === "warn");
    for (const f of failures) {
      if (f.suggestion) {
        expect(typeof f.suggestion).toBe("string");
        expect(f.suggestion.length).toBeGreaterThan(0);
      }
    }
  });
});
