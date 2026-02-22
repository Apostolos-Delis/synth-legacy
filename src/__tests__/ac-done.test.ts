import { describe, test, expect } from "bun:test";
import {
  AC_DONE_PATTERN,
  parseAcDoneMarkers,
  stripAcDoneMarkers,
} from "../engine/ac-done.js";

describe("AC_DONE_PATTERN", () => {
  test("matches <ac-done>N</ac-done> with single digit", () => {
    expect("<ac-done>1</ac-done>").toMatch(new RegExp(AC_DONE_PATTERN.source));
  });

  test("matches multi-digit indices", () => {
    expect("<ac-done>42</ac-done>").toMatch(new RegExp(AC_DONE_PATTERN.source));
  });

  test("does not match non-numeric content", () => {
    expect("<ac-done>abc</ac-done>").not.toMatch(
      new RegExp(AC_DONE_PATTERN.source),
    );
  });

  test("does not match empty tags", () => {
    expect("<ac-done></ac-done>").not.toMatch(
      new RegExp(AC_DONE_PATTERN.source),
    );
  });
});

describe("parseAcDoneMarkers", () => {
  test("returns empty array when no markers present", () => {
    expect(parseAcDoneMarkers("no markers here")).toEqual([]);
  });

  test("extracts single marker", () => {
    expect(parseAcDoneMarkers("done <ac-done>1</ac-done> rest")).toEqual([1]);
  });

  test("extracts multiple markers", () => {
    const text = "<ac-done>1</ac-done> middle <ac-done>3</ac-done>";
    expect(parseAcDoneMarkers(text)).toEqual([1, 3]);
  });

  test("returns 1-based indices as numbers", () => {
    expect(parseAcDoneMarkers("<ac-done>5</ac-done>")).toEqual([5]);
  });

  test("ignores invalid non-numeric content inside tags", () => {
    const text = "<ac-done>abc</ac-done> <ac-done>2</ac-done>";
    expect(parseAcDoneMarkers(text)).toEqual([2]);
  });

  test("ignores empty tags", () => {
    expect(parseAcDoneMarkers("<ac-done></ac-done>")).toEqual([]);
  });

  test("handles markers embedded in multiline text", () => {
    const text = "line1\n<ac-done>1</ac-done>\nline3\n<ac-done>2</ac-done>\n";
    expect(parseAcDoneMarkers(text)).toEqual([1, 2]);
  });

  test("handles adjacent markers", () => {
    const text = "<ac-done>1</ac-done><ac-done>2</ac-done>";
    expect(parseAcDoneMarkers(text)).toEqual([1, 2]);
  });
});

describe("stripAcDoneMarkers", () => {
  test("returns text unchanged when no markers present", () => {
    expect(stripAcDoneMarkers("no markers")).toBe("no markers");
  });

  test("removes single marker", () => {
    expect(stripAcDoneMarkers("before <ac-done>1</ac-done> after")).toBe(
      "before  after",
    );
  });

  test("removes multiple markers", () => {
    const text = "<ac-done>1</ac-done> mid <ac-done>3</ac-done>";
    expect(stripAcDoneMarkers(text)).toBe(" mid ");
  });

  test("removes tags with invalid content too", () => {
    expect(stripAcDoneMarkers("<ac-done>abc</ac-done> text")).toBe(" text");
  });

  test("removes tags with empty content", () => {
    expect(stripAcDoneMarkers("<ac-done></ac-done>rest")).toBe("rest");
  });

  test("preserves surrounding text and whitespace", () => {
    const text = "Hello <ac-done>2</ac-done> world";
    expect(stripAcDoneMarkers(text)).toBe("Hello  world");
  });
});
