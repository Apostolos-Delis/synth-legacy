import { describe, test, expect } from "bun:test";
import { generatePlanId } from "../plans/id.js";

describe("generatePlanId", () => {
  test("generates adjective-noun-number format", () => {
    const id = generatePlanId();
    const parts = id.split("-");
    expect(parts.length).toBe(3);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
    expect(Number(parts[2])).toBeGreaterThanOrEqual(0);
    expect(Number(parts[2])).toBeLessThan(100);
  });

  test("generates different IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(generatePlanId());
    }
    // With 90,000 possible IDs and 50 samples, collisions are extremely unlikely
    expect(ids.size).toBeGreaterThan(40);
  });

  test("contains only lowercase alphanumeric and hyphens", () => {
    for (let i = 0; i < 20; i++) {
      const id = generatePlanId();
      expect(id).toMatch(/^[a-z]+-[a-z]+-\d+$/);
    }
  });
});
