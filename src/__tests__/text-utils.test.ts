import { describe, test, expect } from "bun:test";
import { isAffirmative } from "../utils/text.js";

describe("isAffirmative", () => {
  test("matches common affirmative phrases", () => {
    for (const phrase of ["yes", "ok", "lgtm", "looks good", "ship it", "approve", "sure", "sounds good"]) {
      expect(isAffirmative(phrase)).toBe(true);
    }
  });

  test("is case-insensitive", () => {
    expect(isAffirmative("YES")).toBe(true);
    expect(isAffirmative("Looks Good")).toBe(true);
    expect(isAffirmative("LGTM")).toBe(true);
  });

  test("strips trailing punctuation", () => {
    expect(isAffirmative("yes!")).toBe(true);
    expect(isAffirmative("ok.")).toBe(true);
    expect(isAffirmative("looks good!!")).toBe(true);
    expect(isAffirmative("lgtm...")).toBe(true); // strips trailing dots too
  });

  test("trims whitespace", () => {
    expect(isAffirmative("  yes  ")).toBe(true);
    expect(isAffirmative("\tok\n")).toBe(true);
  });

  test("rejects non-affirmative text", () => {
    expect(isAffirmative("no")).toBe(false);
    expect(isAffirmative("change the title")).toBe(false);
    expect(isAffirmative("add more detail to section 2")).toBe(false);
    expect(isAffirmative("yes but also fix the intro")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isAffirmative("")).toBe(false);
    expect(isAffirmative("   ")).toBe(false);
  });
});
