import { describe, test, expect } from "bun:test";
import { detectRateLimit, getBackoffDelay } from "../engine/rate-limit.js";

describe("detectRateLimit", () => {
  test("detects 429 status code", () => {
    expect(detectRateLimit("HTTP 429 Too Many Requests")).toBe(true);
  });

  test("detects rate limit text", () => {
    expect(detectRateLimit("Error: rate limit exceeded")).toBe(true);
    expect(detectRateLimit("Rate-Limit header present")).toBe(true);
  });

  test("detects too many requests", () => {
    expect(detectRateLimit("too many requests, please try again")).toBe(true);
  });

  test("detects quota exceeded", () => {
    expect(detectRateLimit("API quota exceeded for this key")).toBe(true);
  });

  test("detects retry-after", () => {
    expect(detectRateLimit("Retry-After: 30")).toBe(true);
  });

  test("detects overloaded", () => {
    expect(detectRateLimit("Model is currently overloaded")).toBe(true);
  });

  test("returns false for normal output", () => {
    expect(detectRateLimit("Successfully compiled 42 files")).toBe(false);
    expect(detectRateLimit("Running tests...")).toBe(false);
  });

  test("detects capacity pattern", () => {
    expect(detectRateLimit("at capacity, please wait")).toBe(true);
  });
});

describe("getBackoffDelay", () => {
  test("returns exponential delays", () => {
    expect(getBackoffDelay(0)).toBe(5000);
    expect(getBackoffDelay(1)).toBe(10000);
    expect(getBackoffDelay(2)).toBe(20000);
    expect(getBackoffDelay(3)).toBe(40000);
  });

  test("caps at 120 seconds", () => {
    expect(getBackoffDelay(10)).toBe(120000);
    expect(getBackoffDelay(20)).toBe(120000);
  });
});
