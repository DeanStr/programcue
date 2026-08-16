import { describe, expect, it } from "vitest";

import {
  calculateOverallReadiness,
  calculateReadiness,
} from "./readiness-rules";

describe("readiness rules", () => {
  it("weights task readiness by impact", () => {
    expect(
      calculateReadiness([
        {
          id: "critical",
          impact: "critical",
          readinessPercent: 50,
          blocking: true,
        },
        { id: "low", impact: "low", readinessPercent: 100 },
      ]),
    ).toEqual({ percentage: 60, blockers: 1 });
  });

  it("never reports fully ready while a declared blocker remains", () => {
    expect(
      calculateOverallReadiness(
        [
          { key: "review", score: 100 },
          { key: "schedule", score: 100 },
        ],
        1,
      ),
    ).toBe(99);
  });

  it("rejects invalid workflow percentages", () => {
    expect(() =>
      calculateOverallReadiness([{ key: "review", score: 101 }], 0),
    ).toThrow(/between 0 and 100/);
  });
});
