import { describe, expect, it } from "vitest";
import {
  applyOptimisticSchedulePlacement,
  committedScheduleMove,
  needsAuthoritativeScheduleMoveRefresh,
  reconcileCommittedScheduleMove,
} from "./schedule-planner-optimistic";
import type { SchedulePlannerWorkspaceData } from "./schedule-planner-panel-types";

const originalEntry = {
  id: "entry-one",
  sessionId: "session-one",
  roomId: "room-one",
  startsAt: 1_800_000_000,
  endsAt: 1_800_003_600,
  revision: 2,
};

const originalSession = {
  id: "session-one",
  durationMinutes: 60,
  contentStatus: "approved",
  contentRevision: 4,
  status: "scheduled",
  revision: 5,
};

function workspaceFixture() {
  return {
    version: {
      id: "version-one",
      versionNumber: 2,
      status: "draft",
      revision: 7,
      notes: "",
    },
    entries: [originalEntry],
    sessions: [originalSession],
    conflicts: [
      {
        id: "old-conflict",
        type: "speaker",
        severity: "warning",
        message: "Old warning",
        entryIds: [originalEntry.id, "entry-two"],
      },
    ],
    publicationConflicts: [
      {
        type: "speaker",
        severity: "warning",
        message: "Old warning",
        conflictingEntryId: "entry-two",
        entryIds: [originalEntry.id, "entry-two"],
      },
    ],
    calendarPreviews: {
      [originalEntry.sessionId]: { payload: {}, ics: "stale calendar" },
      "session-two": { payload: {}, ics: "unchanged calendar" },
    },
    publicationPreview: { changes: {} },
    reviewLinkSummary: {
      canCreate: true,
      blockedReason: null,
      entryCount: 1,
      speakerNameCount: 1,
      projectionHash: "a".repeat(64),
      disclosures: [
        {
          title: "Stale session",
          room: "Stale room",
          startsAt: 1_800_000_000,
          speakers: ["Ada"],
        },
      ],
    },
  } as unknown as SchedulePlannerWorkspaceData;
}

describe("optimistic schedule placement", () => {
  it("shows the proposed position without mutating loader data", () => {
    const workspace = workspaceFixture();
    const proposed = {
      ...originalEntry,
      roomId: "room-two",
      startsAt: originalEntry.startsAt + 900,
      endsAt: originalEntry.endsAt + 900,
    };

    const optimistic = applyOptimisticSchedulePlacement(workspace, {
      entry: proposed,
    });

    expect(optimistic.entries).toEqual([proposed]);
    expect(workspace.entries).toEqual([originalEntry]);
    expect(optimistic.version?.revision).toBe(7);
  });

  it("reconciles the authoritative entry without retaining stale previews", () => {
    const workspace = workspaceFixture();
    const placement = {
      ...originalEntry,
      roomId: "room-two",
      startsAt: originalEntry.startsAt + 900,
      endsAt: originalEntry.endsAt + 1_800,
      revision: 3,
    };
    const result = committedScheduleMove({
      ok: true,
      committed: true,
      intent: "place",
      skipRevalidation: true,
      placement,
      session: {
        ...originalSession,
        durationMinutes: 75,
        contentStatus: "draft",
        contentRevision: 5,
        revision: 6,
      },
      scheduleRevision: 8,
      warnings: [
        {
          id: "conflict-three",
          type: "turnaround",
          severity: "warning",
          message: "Short speaker turnaround.",
          conflictingEntryId: "entry-three",
        },
      ],
    });

    expect(result).not.toBeNull();
    const reconciled = reconcileCommittedScheduleMove(workspace, result!);
    expect(reconciled.entries).toEqual([placement]);
    expect(reconciled.sessions).toEqual([
      {
        ...originalSession,
        durationMinutes: 75,
        contentStatus: "draft",
        contentRevision: 5,
        revision: 6,
      },
    ]);
    expect(reconciled.version?.revision).toBe(8);
    expect(reconciled.conflicts).toEqual([
      expect.objectContaining({
        id: "conflict-three",
        type: "turnaround",
        entryIds: [originalEntry.id, "entry-three"],
      }),
    ]);
    expect(reconciled.publicationConflicts).toEqual([
      expect.objectContaining({ type: "turnaround" }),
    ]);
    expect(reconciled.calendarPreviews).toEqual({
      "session-two": { payload: {}, ics: "unchanged calendar" },
    });
    expect(reconciled.publicationPreview).toBeNull();
    expect(reconciled.reviewLinkSummary).toEqual({
      canCreate: true,
      blockedReason: null,
      entryCount: 0,
      speakerNameCount: 0,
      projectionHash: null,
      disclosures: [],
    });
  });

  it("rejects malformed fast-path responses instead of trusting them", () => {
    const malformed = {
      committed: true,
      intent: "place",
      skipRevalidation: true,
      placement: { ...originalEntry, roomId: "" },
      session: originalSession,
      scheduleRevision: 8,
      warnings: [],
    };
    expect(committedScheduleMove(malformed)).toBeNull();
    expect(needsAuthoritativeScheduleMoveRefresh(malformed)).toBe(true);
  });

  it("refreshes when a committed move lacks its session projection", () => {
    const incomplete = {
      committed: true,
      intent: "place",
      skipRevalidation: true,
      placement: originalEntry,
      scheduleRevision: 8,
      warnings: [],
    };
    expect(committedScheduleMove(incomplete)).toBeNull();
    expect(needsAuthoritativeScheduleMoveRefresh(incomplete)).toBe(true);
  });

  it("accepts speaker-unavailability warnings on the committed fast path", () => {
    expect(
      committedScheduleMove({
        committed: true,
        intent: "place",
        skipRevalidation: true,
        placement: originalEntry,
        session: originalSession,
        scheduleRevision: 8,
        warnings: [
          {
            id: "conflict-unavailable",
            type: "speaker_unavailable",
            severity: "warning",
            message: "The speaker is unavailable.",
            speakerId: "person-demo-speaker",
            blackoutWindowId: "window-one",
          },
        ],
      }),
    ).toMatchObject({
      scheduleRevision: 8,
      warnings: [
        expect.objectContaining({
          type: "speaker_unavailable",
          speakerId: "person-demo-speaker",
        }),
      ],
    });
  });

  it("requires persisted identifiers for reconciled warnings", () => {
    expect(
      committedScheduleMove({
        committed: true,
        intent: "place",
        skipRevalidation: true,
        placement: originalEntry,
        session: originalSession,
        scheduleRevision: 8,
        warnings: [
          {
            type: "capacity",
            severity: "warning",
            message: "Room capacity is too low.",
          },
        ],
      }),
    ).toBeNull();
  });

  it("does not refresh after an ordinary rejected placement", () => {
    expect(
      needsAuthoritativeScheduleMoveRefresh({
        ok: false,
        intent: "place",
        skipRevalidation: true,
        error: "That room is already occupied.",
      }),
    ).toBe(false);
  });
});
