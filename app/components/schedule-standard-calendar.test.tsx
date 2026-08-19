import { describe, expect, it, vi } from "vitest";

import {
  scheduleStandardChangedTimes,
  scheduleStandardFirstDay,
} from "./schedule-standard-calendar";

describe("standard schedule calendar presentation", () => {
  it("starts a conference week on the event's first calendar day", () => {
    expect(
      scheduleStandardFirstDay(Date.UTC(2025, 4, 20, 9, 0, 0) / 1_000),
    ).toBe(2);
  });

  it("keeps the dropped position while authoritative validation is pending", () => {
    const entry = {
      id: "entry-one",
      sessionId: "session-one",
      roomId: "room-one",
      startsAt: 1_800_000_000,
      endsAt: 1_800_003_600,
      revision: 3,
    };
    const revert = vi.fn();
    const changed = scheduleStandardChangedTimes(
      {
        event: {
          id: entry.id,
          start: new Date((entry.startsAt + 900) * 1_000),
          end: new Date((entry.endsAt + 900) * 1_000),
        },
        revert,
      } as never,
      new Map([[entry.id, entry]]),
    );

    expect(changed).toEqual({
      entry,
      startsAt: entry.startsAt + 900,
      endsAt: entry.endsAt + 900,
    });
    expect(revert).not.toHaveBeenCalled();
  });

  it("reverts a calendar change that cannot be submitted", () => {
    const revert = vi.fn();
    expect(
      scheduleStandardChangedTimes(
        {
          event: {
            id: "missing-entry",
            start: new Date(1_800_000_000 * 1_000),
            end: new Date(1_800_003_600 * 1_000),
          },
          revert,
        } as never,
        new Map(),
      ),
    ).toBeNull();
    expect(revert).toHaveBeenCalledOnce();
  });
});
