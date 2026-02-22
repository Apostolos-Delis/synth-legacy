import { describe, test, expect } from "bun:test";
import { categorizeFile } from "../finalize/splitter.js";

describe("categorizeFile", () => {
  test("categorizes test files", () => {
    expect(categorizeFile("src/utils.test.ts")).toBe("test");
    expect(categorizeFile("src/app.spec.tsx")).toBe("test");
    expect(categorizeFile("tests/helper.test.js")).toBe("test");
  });

  test("categorizes documentation files", () => {
    expect(categorizeFile("README.md")).toBe("docs");
    expect(categorizeFile("CHANGELOG.md")).toBe("docs");
    expect(categorizeFile("docs/guide.txt")).toBe("docs");
    expect(categorizeFile("docs/api.rst")).toBe("docs");
  });

  test("categorizes style files", () => {
    expect(categorizeFile("src/app.css")).toBe("style");
    expect(categorizeFile("src/theme.scss")).toBe("style");
    expect(categorizeFile("src/global.less")).toBe("style");
  });

  test("categorizes config files", () => {
    expect(categorizeFile("tsconfig.json")).toBe("chore");
    expect(categorizeFile(".eslintrc.json")).toBe("chore");
    expect(categorizeFile("prettier.config.js")).toBe("chore");
  });

  test("categorizes migration files", () => {
    expect(categorizeFile("db/migrations/001_create_users.sql")).toBe("refactor");
  });

  test("defaults to feat for source files", () => {
    expect(categorizeFile("src/engine/engine.ts")).toBe("feat");
    expect(categorizeFile("src/cli.tsx")).toBe("feat");
    expect(categorizeFile("lib/utils.js")).toBe("feat");
  });
});
