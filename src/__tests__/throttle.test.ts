import { describe, test, expect } from "bun:test";
import { createThrottledRender } from "../utils/throttle.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createThrottledRender", () => {
  test("multiple calls within timeout trigger render only once", async () => {
    let callCount = 0;
    const throttled = createThrottledRender(() => {
      callCount++;
    }, 50);

    throttled();
    throttled();
    throttled();

    await delay(100);
    expect(callCount).toBe(1);
  });

  test("render is eventually called after timeout expires", async () => {
    let callCount = 0;
    const throttled = createThrottledRender(() => {
      callCount++;
    }, 30);

    throttled();
    expect(callCount).toBe(0);

    await delay(60);
    expect(callCount).toBe(1);
  });

  test("subsequent calls after timeout trigger another render", async () => {
    let callCount = 0;
    const throttled = createThrottledRender(() => {
      callCount++;
    }, 30);

    throttled();
    await delay(60);
    expect(callCount).toBe(1);

    throttled();
    await delay(60);
    expect(callCount).toBe(2);
  });
});
