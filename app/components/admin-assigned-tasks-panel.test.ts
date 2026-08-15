import { describe, expect, it } from "vitest";

import { dueDistanceLabel } from "./admin-assigned-tasks-panel";

describe("assigned task due-distance labels", () => {
  it("compares event-local calendar dates across midnight", () => {
    const now = Date.parse("2027-05-20T03:59:30Z") / 1_000;

    expect(
      dueDistanceLabel(
        Date.parse("2027-05-20T04:00:30Z") / 1_000,
        now,
        "America/Toronto",
      ).text,
    ).toBe("Due tomorrow");
    expect(
      dueDistanceLabel(
        Date.parse("2027-05-19T03:59:00Z") / 1_000,
        now,
        "America/Toronto",
      ).text,
    ).toBe("1 day overdue");
  });
});
