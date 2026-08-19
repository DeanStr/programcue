import { describe, expect, it } from "vitest";

import { shouldRevalidateScheduleMutation } from "./schedule-planner";

describe("schedule planner mutation revalidation", () => {
  it("does not reload the full workspace after a reconciled move", () => {
    expect(
      shouldRevalidateScheduleMutation(
        { committed: true, intent: "place", skipRevalidation: true },
        true,
      ),
    ).toBe(false);
  });

  it("keeps normal revalidation for mutations without a client projection", () => {
    expect(
      shouldRevalidateScheduleMutation(
        { committed: true, intent: "unassign" },
        true,
      ),
    ).toBe(true);
  });

  it("does not let unrelated action results suppress revalidation", () => {
    expect(
      shouldRevalidateScheduleMutation(
        { intent: "unassign", skipRevalidation: true },
        true,
      ),
    ).toBe(true);
  });
});
