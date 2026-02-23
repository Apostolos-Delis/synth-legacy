import { describe, test, expect } from "bun:test";
import {
  formatAuditReport,
  formatAuditForPr,
  validateFinding,
  type AuditResult,
  type AuditFinding,
} from "../finalize/audit.js";

const baseFinding: AuditFinding = {
  severity: "high",
  file: "src/app.ts",
  line: 42,
  description: "Missing null check",
  suggestedFix: "Add a guard clause",
};

const baseAudit: AuditResult = {
  overall: "warn",
  stories: [
    { story: "US-001 Login flow", verdict: "pass", notes: "Fully implemented" },
    { story: "US-002 Signup flow", verdict: "warn", notes: "Missing validation" },
  ],
  findings: [baseFinding],
  summary: "Changes mostly address the PRD but have gaps.",
};

describe("formatAuditReport (CLI text)", () => {
  test("renders well-formed findings correctly", () => {
    const out = formatAuditReport(baseAudit);
    expect(out).toContain("PRD Audit: WARN");
    expect(out).toContain("[PASS] US-001 Login flow");
    expect(out).toContain("[WARN] US-002 Signup flow");
    expect(out).toContain("Findings:");
    expect(out).toContain("[HIGH] src/app.ts:42 — Missing null check");
    expect(out).toContain("Fix: Add a guard clause");
    expect(out).toContain("Changes mostly address the PRD but have gaps.");
  });

  test("renders multiple findings ordered by input", () => {
    const audit: AuditResult = {
      ...baseAudit,
      findings: [
        { severity: "critical", file: "db.ts", line: 1, description: "SQL injection", suggestedFix: "Use parameterized queries" },
        { severity: "low", file: "util.ts", line: 10, description: "Unused import", suggestedFix: "Remove it" },
      ],
    };
    const out = formatAuditReport(audit);
    expect(out).toContain("[CRITICAL] db.ts:1 — SQL injection");
    expect(out).toContain("[LOW] util.ts:10 — Unused import");
  });

  test("empty findings array produces no Findings section", () => {
    const audit: AuditResult = { ...baseAudit, findings: [] };
    const out = formatAuditReport(audit);
    expect(out).not.toContain("Findings:");
  });

  test("overall pass renders PASS", () => {
    const audit: AuditResult = { ...baseAudit, overall: "pass", findings: [] };
    const out = formatAuditReport(audit);
    expect(out).toContain("PRD Audit: PASS");
  });

  test("overall fail renders FAIL", () => {
    const audit: AuditResult = { ...baseAudit, overall: "fail" };
    const out = formatAuditReport(audit);
    expect(out).toContain("PRD Audit: FAIL");
  });
});

describe("formatAuditForPr (GitHub markdown)", () => {
  test("renders well-formed findings correctly", () => {
    const out = formatAuditForPr(baseAudit);
    expect(out).toContain("## PRD Audit");
    expect(out).toContain("WARN");
    expect(out).toContain("| US-001 Login flow |");
    expect(out).toContain("| US-002 Signup flow |");
    expect(out).toContain("### Findings");
    expect(out).toContain("`src/app.ts:42`");
    expect(out).toContain("Missing null check");
    expect(out).toContain("Add a guard clause");
  });

  test("renders severity icons", () => {
    const findings: AuditFinding[] = [
      { severity: "critical", file: "a.ts", line: 1, description: "d", suggestedFix: "f" },
      { severity: "high", file: "b.ts", line: 2, description: "d", suggestedFix: "f" },
      { severity: "medium", file: "c.ts", line: 3, description: "d", suggestedFix: "f" },
      { severity: "low", file: "d.ts", line: 4, description: "d", suggestedFix: "f" },
    ];
    const audit: AuditResult = { ...baseAudit, findings };
    const out = formatAuditForPr(audit);
    expect(out).toContain("\u{1F534} critical");
    expect(out).toContain("\u{1F7E0} high");
    expect(out).toContain("\u{1F7E1} medium");
    expect(out).toContain("\u{1F535} low");
  });

  test("empty findings array produces no Findings section", () => {
    const audit: AuditResult = { ...baseAudit, findings: [] };
    const out = formatAuditForPr(audit);
    expect(out).not.toContain("### Findings");
  });

  test("renders markdown table for stories", () => {
    const out = formatAuditForPr(baseAudit);
    expect(out).toContain("| Story | Verdict | Notes |");
    expect(out).toContain("|-------|---------|-------|");
  });
});

describe("validateFinding", () => {
  test("valid finding passes validation", () => {
    const result = validateFinding(baseFinding);
    expect(result).toEqual(baseFinding);
  });

  test("null returns null", () => {
    expect(validateFinding(null)).toBeNull();
  });

  test("undefined returns null", () => {
    expect(validateFinding(undefined)).toBeNull();
  });

  test("missing severity returns null", () => {
    expect(validateFinding({ file: "a.ts", line: 1, description: "d", suggestedFix: "f" })).toBeNull();
  });

  test("missing file returns null", () => {
    expect(validateFinding({ severity: "high", line: 1, description: "d", suggestedFix: "f" })).toBeNull();
  });

  test("missing description returns null", () => {
    expect(validateFinding({ severity: "high", file: "a.ts", line: 1, suggestedFix: "f" })).toBeNull();
  });

  test("string line is coerced to number", () => {
    const result = validateFinding({ severity: "high", file: "a.ts", line: "42", description: "d", suggestedFix: "f" });
    expect(result).not.toBeNull();
    expect(result!.line).toBe(42);
  });

  test("missing line defaults to 0", () => {
    const result = validateFinding({ severity: "high", file: "a.ts", description: "d", suggestedFix: "f" });
    expect(result).not.toBeNull();
    expect(result!.line).toBe(0);
  });

  test("non-numeric line defaults to 0", () => {
    const result = validateFinding({ severity: "high", file: "a.ts", line: "abc", description: "d", suggestedFix: "f" });
    expect(result).not.toBeNull();
    expect(result!.line).toBe(0);
  });

  test("missing suggestedFix defaults to empty string", () => {
    const result = validateFinding({ severity: "high", file: "a.ts", line: 1, description: "d" });
    expect(result).not.toBeNull();
    expect(result!.suggestedFix).toBe("");
  });

  test("empty object returns null", () => {
    expect(validateFinding({})).toBeNull();
  });

  test("filters mixed valid and invalid entries via map+filter", () => {
    const raw = [
      baseFinding,
      { severity: "high" },
      null,
      { severity: "low", file: "b.ts", line: 5, description: "ok", suggestedFix: "" },
    ];
    const result = raw.map(validateFinding).filter((f): f is AuditFinding => f !== null);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(baseFinding);
    expect(result[1].file).toBe("b.ts");
  });
});
