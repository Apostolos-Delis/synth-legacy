import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { loadTemplate, renderTemplate } from "../templates/engine.js";
import {
  getBuiltinTemplate,
  getBuiltinTemplateOrDefault,
  INTERVIEW_TEMPLATE,
  PLAN_TEMPLATE,
  REVIEW_TEMPLATE,
  AUDIT_TEMPLATE,
  SELF_REVIEW_TEMPLATE,
} from "../templates/builtin.js";
import type { TemplateVariables, TemplateLoadResult } from "../templates/types.js";
import { writeText, ensureDir } from "../utils/fs.js";
import { withTmpDir } from "./helpers.js";

function makeVariables(overrides?: Partial<TemplateVariables>): TemplateVariables {
  return {
    agentName: "claude",
    cwd: "/tmp/test",
    currentDate: "2026-02-24",
    slug: "test-slug",
    taskId: "US-001",
    taskTitle: "Test task",
    taskDescription: "A test task",
    acceptanceCriteria: ["criterion 1"],
    priority: 3,
    iteration: 1,
    ...overrides,
  };
}

describe("getBuiltinTemplate", () => {
  test("returns claude template for 'claude'", () => {
    const t = getBuiltinTemplate("claude");
    expect(t).not.toBeNull();
    expect(t).toContain("Agent-Specific Guidance (Claude)");
  });

  test("returns codex template for 'codex'", () => {
    const t = getBuiltinTemplate("codex");
    expect(t).not.toBeNull();
    expect(t).toContain("Agent-Specific Guidance (Codex)");
  });

  test("returns default template for 'default'", () => {
    const t = getBuiltinTemplate("default");
    expect(t).not.toBeNull();
    expect(t).toContain("autonomous coding agent");
    expect(t).not.toContain("Agent-Specific Guidance");
  });

  test("returns null for unknown agent", () => {
    expect(getBuiltinTemplate("unknown-agent")).toBeNull();
  });
});

describe("getBuiltinTemplateOrDefault", () => {
  test("returns agent template when it exists", () => {
    const t = getBuiltinTemplateOrDefault("claude");
    expect(t).toContain("Agent-Specific Guidance (Claude)");
  });

  test("falls back to default for unknown agent", () => {
    const t = getBuiltinTemplateOrDefault("unknown-agent");
    expect(t).toContain("autonomous coding agent");
    expect(t).not.toContain("Agent-Specific Guidance");
  });
});

describe("loadTemplate", () => {
  test("returns builtin for known agent when no file overrides exist", async () => {
    await withTmpDir(async (dir) => {
      const result = await loadTemplate("claude", dir);
      expect(result.source).toBe("builtin");
      expect(result.template).toContain("Agent-Specific Guidance (Claude)");
      expect(result.path).toBeUndefined();
    });
  });

  test("returns builtin-default for unknown agent", async () => {
    await withTmpDir(async (dir) => {
      const result = await loadTemplate("unknown-agent", dir);
      expect(result.source).toBe("builtin-default");
      expect(result.template).toContain("autonomous coding agent");
    });
  });

  test("project template overrides builtin", async () => {
    await withTmpDir(async (dir) => {
      const templateDir = join(dir, "synth-templates");
      await ensureDir(templateDir);
      await writeText(join(templateDir, "claude.hbs"), "Custom Claude: {{slug}}");
      const result = await loadTemplate("claude", dir);
      expect(result.source).toBe("project");
      expect(result.template).toBe("Custom Claude: {{slug}}");
      expect(result.path).toBe(join(templateDir, "claude.hbs"));
    });
  });

  test("explicit path overrides project template", async () => {
    await withTmpDir(async (dir) => {
      // Create project template
      const templateDir = join(dir, "synth-templates");
      await ensureDir(templateDir);
      await writeText(join(templateDir, "claude.hbs"), "Project template");

      // Create explicit path template
      const explicitPath = join(dir, "custom.hbs");
      await writeText(explicitPath, "Explicit: {{agentName}}");

      const result = await loadTemplate("claude", dir, explicitPath);
      expect(result.source).toBe("explicit");
      expect(result.template).toBe("Explicit: {{agentName}}");
      expect(result.path).toBe(explicitPath);
    });
  });

  test("falls through when explicit path doesn't exist", async () => {
    await withTmpDir(async (dir) => {
      const result = await loadTemplate("claude", dir, "/nonexistent/path.hbs");
      expect(result.source).toBe("builtin");
    });
  });

  test("global template overrides builtin", async () => {
    await withTmpDir(async (dir) => {
      const fakeHome = join(dir, "fakehome");
      const globalDir = join(fakeHome, ".synth", "templates");
      await ensureDir(globalDir);
      await writeText(join(globalDir, "claude.hbs"), "Global Claude: {{slug}}");

      // Use a different cwd with no project templates
      const cwd = join(dir, "project");
      await ensureDir(cwd);

      const result = await loadTemplate("claude", cwd, { homeDir: fakeHome });
      expect(result.source).toBe("global");
      expect(result.template).toBe("Global Claude: {{slug}}");
      expect(result.path).toBe(join(globalDir, "claude.hbs"));
    });
  });
});

describe("renderTemplate", () => {
  test("renders Handlebars variables", () => {
    const loadResult: TemplateLoadResult = {
      source: "builtin",
      template: "Agent: {{agentName}}, Slug: {{slug}}, Iteration: {{iteration}}",
    };
    const vars = makeVariables();
    const result = renderTemplate(loadResult, vars);
    expect(result.rendered).toBe("Agent: claude, Slug: test-slug, Iteration: 1");
    expect(result.source).toBe("builtin");
  });

  test("renders template with slug substitution", () => {
    const loadResult: TemplateLoadResult = {
      source: "builtin",
      template: "feat: [{{slug}}] description",
    };
    const result = renderTemplate(loadResult, makeVariables({ slug: "jwt-auth" }));
    expect(result.rendered).toBe("feat: [jwt-auth] description");
  });

  test("preserves path from load result", () => {
    const loadResult: TemplateLoadResult = {
      source: "project",
      path: "/some/path.hbs",
      template: "Hello {{agentName}}",
    };
    const result = renderTemplate(loadResult, makeVariables());
    expect(result.path).toBe("/some/path.hbs");
  });

  test("renders consistently across multiple calls", () => {
    const loadResult: TemplateLoadResult = {
      source: "builtin",
      template: "{{agentName}} - {{slug}} - {{iteration}}",
    };
    const vars = makeVariables();
    const first = renderTemplate(loadResult, vars);
    const second = renderTemplate(loadResult, vars);
    expect(first.rendered).toBe(second.rendered);
    expect(second.rendered).toBe("claude - test-slug - 1");
  });

  test("does not HTML-escape content", () => {
    const loadResult: TemplateLoadResult = {
      source: "builtin",
      template: "{{taskDescription}}",
    };
    const result = renderTemplate(
      loadResult,
      makeVariables({ taskDescription: "Use <promise>COMPLETE</promise> tag" }),
    );
    expect(result.rendered).toBe("Use <promise>COMPLETE</promise> tag");
  });

  test("falls back to raw template when syntax is malformed", () => {
    const loadResult: TemplateLoadResult = {
      source: "project",
      path: "/bad/template.hbs",
      template: "Hello {{#if broken",
    };
    const result = renderTemplate(loadResult, makeVariables());
    expect(result.rendered).toBe("Hello {{#if broken");
    expect(result.source).toBe("project");
    expect(result.path).toBe("/bad/template.hbs");
  });
});

// ---------------------------------------------------------------------------
// Phase-aware builtin lookups
// ---------------------------------------------------------------------------

describe("getBuiltinTemplate — phased keys", () => {
  test("returns execute/claude for phased key", () => {
    const t = getBuiltinTemplate("execute/claude");
    expect(t).not.toBeNull();
    expect(t).toContain("Agent-Specific Guidance (Claude)");
  });

  test("returns interview/default", () => {
    const t = getBuiltinTemplate("interview/default");
    expect(t).not.toBeNull();
    expect(t).toBe(INTERVIEW_TEMPLATE);
  });

  test("returns plan/default", () => {
    const t = getBuiltinTemplate("plan/default");
    expect(t).not.toBeNull();
    expect(t).toBe(PLAN_TEMPLATE);
  });

  test("returns review/default", () => {
    const t = getBuiltinTemplate("review/default");
    expect(t).not.toBeNull();
    expect(t).toBe(REVIEW_TEMPLATE);
  });

  test("returns audit/default", () => {
    const t = getBuiltinTemplate("audit/default");
    expect(t).not.toBeNull();
    expect(t).toBe(AUDIT_TEMPLATE);
  });

  test("returns audit/self-review", () => {
    const t = getBuiltinTemplate("audit/self-review");
    expect(t).not.toBeNull();
    expect(t).toBe(SELF_REVIEW_TEMPLATE);
  });

  test("backward-compat: un-phased 'claude' still works", () => {
    const phased = getBuiltinTemplate("execute/claude");
    const unphased = getBuiltinTemplate("claude");
    expect(phased).toBe(unphased);
  });
});

// ---------------------------------------------------------------------------
// Phase-aware loadTemplate
// ---------------------------------------------------------------------------

describe("loadTemplate — phase-aware", () => {
  test("returns phased builtin for execute/claude", async () => {
    await withTmpDir(async (dir) => {
      const result = await loadTemplate("claude", dir, { phase: "execute" });
      expect(result.source).toBe("builtin");
      expect(result.template).toContain("Agent-Specific Guidance (Claude)");
    });
  });

  test("returns interview builtin for interview phase", async () => {
    await withTmpDir(async (dir) => {
      const result = await loadTemplate("default", dir, { phase: "interview" });
      expect(result.source).toBe("builtin");
      expect(result.template).toBe(INTERVIEW_TEMPLATE);
    });
  });

  test("returns plan builtin for plan phase", async () => {
    await withTmpDir(async (dir) => {
      const result = await loadTemplate("default", dir, { phase: "plan" });
      expect(result.source).toBe("builtin");
      expect(result.template).toBe(PLAN_TEMPLATE);
    });
  });

  test("returns audit builtin for audit phase", async () => {
    await withTmpDir(async (dir) => {
      const result = await loadTemplate("default", dir, { phase: "audit" });
      expect(result.source).toBe("builtin");
      expect(result.template).toBe(AUDIT_TEMPLATE);
    });
  });

  test("falls back to phase/default when agent-specific phased template doesn't exist", async () => {
    await withTmpDir(async (dir) => {
      const result = await loadTemplate("some-custom-agent", dir, { phase: "interview" });
      expect(result.source).toBe("builtin-default");
      expect(result.template).toBe(INTERVIEW_TEMPLATE);
    });
  });

  test("phased project template overrides builtin", async () => {
    await withTmpDir(async (dir) => {
      const phaseDir = join(dir, "synth-templates", "plan");
      await ensureDir(phaseDir);
      await writeText(join(phaseDir, "claude.hbs"), "Custom plan: {{slug}}");

      const result = await loadTemplate("claude", dir, { phase: "plan" });
      expect(result.source).toBe("project");
      expect(result.template).toBe("Custom plan: {{slug}}");
      expect(result.path).toBe(join(phaseDir, "claude.hbs"));
    });
  });

  test("phased global template overrides builtin", async () => {
    await withTmpDir(async (dir) => {
      const fakeHome = join(dir, "fakehome");
      const globalPhaseDir = join(fakeHome, ".synth", "templates", "interview");
      await ensureDir(globalPhaseDir);
      await writeText(join(globalPhaseDir, "claude.hbs"), "Global interview: {{agentName}}");

      const cwd = join(dir, "project");
      await ensureDir(cwd);

      const result = await loadTemplate("claude", cwd, { phase: "interview", homeDir: fakeHome });
      expect(result.source).toBe("global");
      expect(result.template).toBe("Global interview: {{agentName}}");
    });
  });

  test("un-phased project template still works as fallback for execute phase", async () => {
    await withTmpDir(async (dir) => {
      const templateDir = join(dir, "synth-templates");
      await ensureDir(templateDir);
      await writeText(join(templateDir, "claude.hbs"), "Legacy project template");

      const result = await loadTemplate("claude", dir, { phase: "execute" });
      expect(result.source).toBe("project");
      expect(result.template).toBe("Legacy project template");
    });
  });

  test("no phase behaves like legacy (backward compat)", async () => {
    await withTmpDir(async (dir) => {
      const result = await loadTemplate("claude", dir);
      expect(result.source).toBe("builtin");
      expect(result.template).toContain("Agent-Specific Guidance (Claude)");
    });
  });
});
