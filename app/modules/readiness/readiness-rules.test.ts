import { describe, expect, it } from "vitest";

import {
  calculateOverallReadiness,
  calculateReadiness,
  operationalReadinessStatus,
  selectTopReadinessAction,
  summarizeReadinessConditions,
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

  it("counts overlapping affected records as distinct condition categories", () => {
    expect(
      summarizeReadinessConditions([
        { severity: "danger" },
        { severity: "danger" },
        { severity: "warning" },
      ]),
    ).toEqual({
      criticalConditionCount: 2,
      warningConditionCount: 1,
    });
  });

  it.each([
    {
      percentage: 80,
      criticalConditionCount: 1,
      warningConditionCount: 0,
      expected: "needs_attention",
    },
    {
      percentage: 80,
      criticalConditionCount: 0,
      warningConditionCount: 2,
      expected: "on_track",
    },
    {
      percentage: 60,
      criticalConditionCount: 0,
      warningConditionCount: 0,
      expected: "at_risk",
    },
    {
      percentage: 100,
      criticalConditionCount: 0,
      warningConditionCount: 0,
      expected: "ready",
    },
    {
      percentage: 100,
      criticalConditionCount: 0,
      warningConditionCount: 1,
      expected: "on_track",
    },
  ])(
    "reports $expected at $percentage% with $criticalConditionCount critical and $warningConditionCount warning conditions",
    ({ expected, ...input }) => {
      expect(operationalReadinessStatus(input)).toBe(expected);
    },
  );

  it("rejects invalid operational condition counts", () => {
    expect(() =>
      operationalReadinessStatus({
        percentage: 80,
        criticalConditionCount: -1,
        warningConditionCount: 0,
      }),
    ).toThrow(/non-negative integer/);
  });

  it("selects one stable operational action independently of query order", () => {
    const conditions = [
      { key: "speaker_assets", severity: "warning" as const },
      { key: "overdue_tasks", severity: "danger" as const },
      { key: "schedule_conflicts", severity: "danger" as const },
    ];
    expect(selectTopReadinessAction(conditions)).toEqual(
      expect.objectContaining({ key: "schedule_conflicts" }),
    );
    expect(selectTopReadinessAction([...conditions].reverse())).toEqual(
      expect.objectContaining({ key: "schedule_conflicts" }),
    );
    expect(selectTopReadinessAction([])).toBeNull();
  });
});
