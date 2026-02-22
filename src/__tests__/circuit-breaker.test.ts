import { describe, test, expect } from "bun:test";
import { CircuitBreaker } from "../engine/circuit-breaker.js";

describe("CircuitBreaker", () => {
  test("starts with 0 failures", () => {
    const cb = new CircuitBreaker(3);
    expect(cb.failures).toBe(0);
    expect(cb.isTripped()).toBe(false);
  });

  test("trips after threshold failures", () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure();
    expect(cb.isTripped()).toBe(false);
    cb.recordFailure();
    expect(cb.isTripped()).toBe(false);
    cb.recordFailure();
    expect(cb.isTripped()).toBe(true);
  });

  test("resets on success", () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.failures).toBe(0);
    expect(cb.isTripped()).toBe(false);
  });

  test("recordFailure returns tripped state", () => {
    const cb = new CircuitBreaker(2);
    expect(cb.recordFailure()).toBe(false);
    expect(cb.recordFailure()).toBe(true);
  });

  test("reset clears failures", () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();
    cb.reset();
    expect(cb.failures).toBe(0);
  });

  test("threshold of 1 trips on first failure", () => {
    const cb = new CircuitBreaker(1);
    expect(cb.recordFailure()).toBe(true);
  });
});
