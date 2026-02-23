import { describe, test, expect } from "bun:test";
import { deriveSessionSlug, deriveTaskPrefix } from "../sessions/slug.js";

describe("deriveSessionSlug", () => {
  test("strips filler words and kebab-cases", () => {
    expect(deriveSessionSlug("Add JWT Authentication")).toBe("jwt-authentication");
  });

  test("handles simple title", () => {
    expect(deriveSessionSlug("Session Naming")).toBe("session-naming");
  });

  test("strips multiple filler words", () => {
    expect(deriveSessionSlug("Implement and Build User Dashboard")).toBe("user-dashboard");
  });

  test("handles title with special characters", () => {
    expect(deriveSessionSlug("Add `code` & **bold** feature!")).toBe("code-bold-feature");
  });

  test("truncates at word boundary when over 30 chars", () => {
    const slug = deriveSessionSlug("Add Very Long Feature Name That Exceeds The Maximum Character Limit");
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug).not.toEndWith("-");
  });

  test("returns 'session' for empty title", () => {
    expect(deriveSessionSlug("")).toBe("session");
  });

  test("returns 'session' for title with only filler words", () => {
    expect(deriveSessionSlug("Add and Create")).toBe("session");
  });

  test("handles single significant word", () => {
    expect(deriveSessionSlug("Add Authentication")).toBe("authentication");
  });

  test("handles acronyms", () => {
    expect(deriveSessionSlug("Setup API Integration")).toBe("api-integration");
  });

  test("handles numeric-only content", () => {
    expect(deriveSessionSlug("123 456")).toBe("123-456");
  });

  test("handles unicode characters by stripping them", () => {
    expect(deriveSessionSlug("Add émoji 🎉 rendering")).toBe("moji-rendering");
  });

  test("handles hyphenated words", () => {
    expect(deriveSessionSlug("Add real-time notifications")).toBe("real-time-notifications");
  });

  test("handles single-character significant word", () => {
    expect(deriveSessionSlug("Add X feature")).toBe("x-feature");
  });
});

describe("deriveTaskPrefix", () => {
  test("picks acronym when present", () => {
    expect(deriveTaskPrefix("Add JWT Authentication")).toBe("JWT");
  });

  test("uses last significant word when no acronym", () => {
    expect(deriveTaskPrefix("Add User Authentication")).toBe("AUTH");
  });

  test("falls back to TASK for empty title", () => {
    expect(deriveTaskPrefix("")).toBe("TASK");
  });

  test("falls back to TASK for only filler words", () => {
    expect(deriveTaskPrefix("Add and Create")).toBe("TASK");
  });

  test("truncates long words to 4 chars", () => {
    expect(deriveTaskPrefix("Add Authentication")).toBe("AUTH");
  });

  test("picks API as acronym", () => {
    expect(deriveTaskPrefix("Build API Endpoints")).toBe("API");
  });

  test("handles single word title", () => {
    expect(deriveTaskPrefix("Refactor Dashboard")).toBe("DASH");
  });

  test("prefix is always uppercase", () => {
    const prefix = deriveTaskPrefix("session naming");
    expect(prefix).toBe(prefix.toUpperCase());
  });

  test("prefix length is 2-5 characters", () => {
    const cases = [
      "Add JWT Authentication",
      "Build User Dashboard",
      "Fix Login Bug",
      "Implement Rate Limiting",
    ];
    for (const title of cases) {
      const prefix = deriveTaskPrefix(title);
      expect(prefix.length).toBeGreaterThanOrEqual(2);
      expect(prefix.length).toBeLessThanOrEqual(5); // acronyms can be up to 5
    }
  });

  test("handles numeric title", () => {
    expect(deriveTaskPrefix("Add 404 Page")).toBe("PAGE");
  });

  test("handles hyphenated compound word", () => {
    expect(deriveTaskPrefix("Add real-time sync")).toBe("SYNC");
  });

  test("handles single-char significant word with fallback to initials", () => {
    // Single char "X" is too short (< 2), so falls back to initials
    const prefix = deriveTaskPrefix("Add X");
    expect(prefix.length).toBeGreaterThanOrEqual(2);
  });
});
