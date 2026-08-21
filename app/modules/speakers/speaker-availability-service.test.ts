import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import {
  prepareScheduleServiceTest,
  scheduleTestEnv,
  scheduleTestViewer,
} from "~/modules/schedule/schedule-service-test-fixture";
import {
  eventBoundaryCalendarDate,
  eventLocalTimeEpoch,
} from "~/modules/schedule/schedule-time";
import type { Viewer } from "~/platform/auth/authorize.server";
import { SpeakerAvailabilityService } from "./speaker-availability-service.server";
import { SpeakerAdminStateError } from "./speaker-service-errors";

const speaker: Viewer = {
  personId: "person-demo-speaker",
  name: "Priya Shah",
  email: "priya.speaker@example.com",
  role: "speaker",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const submitter: Viewer = {
  personId: "person-demo-submitter",
  name: "Alex Morgan",
  email: "alex.submitter@example.com",
  role: "submitter",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

beforeEach(prepareScheduleServiceTest);

describe("speaker availability", () => {
  it("lets a speaker create a window that blocks overlapping placement", async () => {
    const availability = new SpeakerAvailabilityService(scheduleTestEnv);
    const schedule = new ScheduleService(scheduleTestEnv);
    const versionId = await schedule.createDraft(scheduleTestViewer);
    let workspace = await schedule.getWorkspace(scheduleTestViewer);
    const startDate = eventBoundaryCalendarDate(workspace.event.startsAt);
    const created = await availability.createOwnWindow(speaker, {
      eventRevision: workspace.event.revision,
      startDate,
      endDate: startDate,
      startTime: "09:00",
      endTime: "10:00",
      allDay: false,
      note: "Travel day",
    });
    const stored = await env.DB.prepare(
      `SELECT note, starts_at AS startsAt, ends_at AS endsAt
         FROM speaker_blackout_windows WHERE id = ?`,
    )
      .bind(created.windowId)
      .first<{ note: string | null; startsAt: number; endsAt: number }>();
    expect(stored).toMatchObject({ note: "Travel day" });
    workspace = await schedule.getWorkspace(scheduleTestViewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    expect(stored?.startsAt).toBe(startsAt);
    expect(workspace.speakerBlackouts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.windowId,
          personId: speaker.personId,
        }),
      ]),
    );
    await expect(
      schedule.place(scheduleTestViewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
        sessionId: "schedule-test-one",
        roomId: "main",
        startsAt,
        endsAt: startsAt + 3_600,
      }),
    ).rejects.toMatchObject({
      conflicts: [
        expect.objectContaining({
          type: "speaker_unavailable",
          blackoutWindowId: created.windowId,
        }),
      ],
    });
    const adminWindows = await availability.listAdminWindows(
      scheduleTestViewer,
      speaker.personId,
    );
    expect(adminWindows.windows[0]?.note).toBeNull();
  });

  it("rejects generic submitters", async () => {
    const availability = new SpeakerAvailabilityService(scheduleTestEnv);
    const personId = `submitter-only-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO people (id, email, display_name, email_verified, profile_status)
         VALUES (?, ?, 'Submitter Only', 1, 'draft')`,
      ).bind(personId, `${personId}@programcue.dev`),
      env.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, created_at
         ) VALUES (?, ?, ?, ?, 'submitter', unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        submitter.organisationId,
        submitter.eventId,
        personId,
      ),
    ]);
    const onlySubmitter: Viewer = { ...submitter, personId };
    await expect(availability.canManage(onlySubmitter)).resolves.toBe(false);
    await expect(
      availability.createOwnWindow(onlySubmitter, {
        eventRevision: 1,
        startDate: "2027-05-20",
        endDate: "2027-05-20",
        startTime: "09:00",
        endTime: "10:00",
        allDay: false,
        note: "",
      }),
    ).rejects.toBeInstanceOf(SpeakerAdminStateError);
  });

  it("rejects overlapping windows for the same speaker", async () => {
    const availability = new SpeakerAvailabilityService(scheduleTestEnv);
    const event = await env.DB.prepare(
      "SELECT revision, starts_at AS startsAt FROM events WHERE id = ?",
    )
      .bind(speaker.eventId)
      .first<{ revision: number; startsAt: number }>();
    const startDate = eventBoundaryCalendarDate(event!.startsAt);
    await availability.createOwnWindow(speaker, {
      eventRevision: event!.revision,
      startDate,
      endDate: startDate,
      startTime: "09:00",
      endTime: "11:00",
      allDay: false,
      note: "",
    });
    const after = await env.DB.prepare(
      "SELECT revision FROM events WHERE id = ?",
    )
      .bind(speaker.eventId)
      .first<{ revision: number }>();
    await expect(
      availability.createOwnWindow(speaker, {
        eventRevision: after!.revision,
        startDate,
        endDate: startDate,
        startTime: "10:00",
        endTime: "12:00",
        allDay: false,
        note: "",
      }),
    ).rejects.toThrow(/cannot overlap/i);
  });

  it("returns a 422 for a nonexistent spring-forward local time", async () => {
    const availability = new SpeakerAvailabilityService(scheduleTestEnv);
    const event = await env.DB.prepare(
      "SELECT revision FROM events WHERE id = ?",
    )
      .bind(speaker.eventId)
      .first<{ revision: number }>();
    await expect(
      availability.createOwnWindow(speaker, {
        eventRevision: event!.revision,
        startDate: "2027-03-14",
        endDate: "2027-03-14",
        startTime: "02:30",
        endTime: "03:30",
        allDay: false,
        note: "",
      }),
    ).rejects.toMatchObject({
      name: "SpeakerAdminStateError",
      status: 422,
      message: expect.stringMatching(/does not exist/i),
    });
  });

  it("accepts exact minute times including optional zero seconds", async () => {
    const availability = new SpeakerAvailabilityService(scheduleTestEnv);
    const event = await env.DB.prepare(
      "SELECT revision, starts_at AS startsAt FROM events WHERE id = ?",
    )
      .bind(speaker.eventId)
      .first<{ revision: number; startsAt: number }>();
    const startDate = eventBoundaryCalendarDate(event!.startsAt);
    const created = await availability.createOwnWindow(speaker, {
      eventRevision: event!.revision,
      startDate,
      endDate: startDate,
      startTime: "09:00:00",
      endTime: "10:00:00",
      allDay: false,
      note: "",
    });
    expect(created.startsAt).toBe(
      eventLocalTimeEpoch(event!.startsAt, "America/Toronto", 9),
    );
  });

  it("rejects times that include non-zero seconds", async () => {
    const availability = new SpeakerAvailabilityService(scheduleTestEnv);
    const event = await env.DB.prepare(
      "SELECT revision, starts_at AS startsAt FROM events WHERE id = ?",
    )
      .bind(speaker.eventId)
      .first<{ revision: number; startsAt: number }>();
    const startDate = eventBoundaryCalendarDate(event!.startsAt);
    await expect(
      availability.createOwnWindow(speaker, {
        eventRevision: event!.revision,
        startDate,
        endDate: startDate,
        startTime: "09:00:59",
        endTime: "10:00:00",
        allDay: false,
        note: "",
      }),
    ).rejects.toThrow(/valid time/i);
  });

  it("labels organiser overlaps with the draft session title", async () => {
    const availability = new SpeakerAvailabilityService(scheduleTestEnv);
    const schedule = new ScheduleService(scheduleTestEnv);
    const versionId = await schedule.createDraft(scheduleTestViewer);
    let workspace = await schedule.getWorkspace(scheduleTestViewer);
    const startDate = eventBoundaryCalendarDate(workspace.event.startsAt);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await schedule.place(scheduleTestViewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    workspace = await schedule.getWorkspace(scheduleTestViewer);
    await env.DB.prepare(
      `UPDATE schedule_session_contents
          SET title = 'Draft-only overlap title'
        WHERE schedule_version_id = ? AND event_id = ?
          AND session_id = 'schedule-test-one'`,
    )
      .bind(versionId, speaker.eventId)
      .run();
    await availability.createOwnWindow(speaker, {
      eventRevision: workspace.event.revision,
      startDate,
      endDate: startDate,
      startTime: "09:00",
      endTime: "10:00",
      allDay: false,
      note: "Keep this note private",
    });
    const adminWindows = await availability.listAdminWindows(
      scheduleTestViewer,
      speaker.personId,
    );
    expect(adminWindows.windows[0]?.note).toBeNull();
    expect(adminWindows.windows[0]?.overlappingSessions).toEqual([
      expect.objectContaining({
        id: "schedule-test-one",
        title: "Draft-only overlap title",
      }),
    ]);
  });

  it("runs availability mutations behind the Airtable command boundary", async () => {
    let reads = 0;
    let commands = 0;
    const operations: string[] = [];
    const airtable = {
      assertReadable: async () => {
        reads += 1;
        return null;
      },
      executeIdempotent: async (
        _scope: unknown,
        input: { operation: string },
        command: () => Promise<unknown>,
      ) => {
        commands += 1;
        operations.push(input.operation);
        return command();
      },
    } as unknown as AirtableProviderBoundary;
    const availability = new SpeakerAvailabilityService(
      scheduleTestEnv,
      airtable,
    );
    const event = await env.DB.prepare(
      "SELECT revision, starts_at AS startsAt FROM events WHERE id = ?",
    )
      .bind(speaker.eventId)
      .first<{ revision: number; startsAt: number }>();
    const startDate = eventBoundaryCalendarDate(event!.startsAt);
    await availability.listOwnWindows(speaker);
    expect(reads).toBe(1);
    await availability.createOwnWindow(speaker, {
      eventRevision: event!.revision,
      startDate,
      endDate: startDate,
      startTime: "11:00",
      endTime: "12:00",
      allDay: false,
      note: "",
    });
    expect(reads).toBe(2);
    expect(commands).toBe(1);
    expect(operations).toEqual(["speaker.availability.create"]);
  });

  it("does not checkpoint Airtable when checking availability write access", async () => {
    let reads = 0;
    const airtable = {
      assertReadable: async () => {
        reads += 1;
        return null;
      },
    } as unknown as AirtableProviderBoundary;
    const availability = new SpeakerAvailabilityService(
      scheduleTestEnv,
      airtable,
    );
    await expect(availability.canManage(speaker)).resolves.toBe(true);
    expect(reads).toBe(0);
  });
});
