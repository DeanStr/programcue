import { describe, expect, it } from "vitest";

import { visibleSchedulePublicationError } from "./schedule-planner-dialogs";
import {
  parseScheduleActionNotices,
  SCHEDULE_ACTION_INVALID_RESPONSE_MESSAGE,
} from "./schedule-planner-workspace";

const validWarning = {
  type: "speaker",
  severity: "warning",
  message: "A speaker has insufficient turnaround time.",
} as const;

describe("schedule action response notices", () => {
  it("accepts complete conflict and warning details", () => {
    expect(
      parseScheduleActionNotices({
        conflicts: [
          {
            type: "room",
            severity: "blocking",
            message: "The room is already occupied.",
            conflictingEntryId: "entry-one",
          },
        ],
        warnings: [validWarning],
      }),
    ).toEqual({
      conflicts: [
        {
          type: "room",
          severity: "blocking",
          message: "The room is already occupied.",
          conflictingEntryId: "entry-one",
        },
      ],
      warnings: [validWarning],
      error: null,
    });
  });

  it("rejects a partially malformed notice array instead of filtering it", () => {
    expect(
      parseScheduleActionNotices({
        warnings: [validWarning, { type: "room", severity: "warning" }],
      }),
    ).toEqual({
      conflicts: [],
      warnings: [],
      error: SCHEDULE_ACTION_INVALID_RESPONSE_MESSAGE,
    });
  });

  it("rejects a malformed notice collection instead of treating it as empty", () => {
    expect(
      parseScheduleActionNotices({
        conflicts: { type: "room", severity: "blocking" },
      }),
    ).toEqual({
      conflicts: [],
      warnings: [],
      error: SCHEDULE_ACTION_INVALID_RESPONSE_MESSAGE,
    });
  });
});

describe("schedule publication dialog leftover errors", () => {
  const leftoverFailure = {
    intent: "publish",
    error: "The schedule draft changed while you were reviewing publication.",
    conflict: true,
  };

  it("hides a leftover failed publish result until this dialog instance submits", () => {
    expect(visibleSchedulePublicationError(leftoverFailure, false)).toBeNull();
  });

  it("shows a failed publish result after this dialog instance submits", () => {
    expect(visibleSchedulePublicationError(leftoverFailure, true)).toEqual({
      message: leftoverFailure.error,
      conflict: true,
    });
  });
});
