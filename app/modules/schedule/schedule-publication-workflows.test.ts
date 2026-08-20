import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ContentManagementService } from "~/modules/content/content-management-service.server";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { processScheduleCalendarFanout } from "../../../workers/communications-queue";
import { ScheduleService } from "./schedule-service.server";
import {
  approveScheduledTestContent,
  prepareScheduleServiceTest,
  scheduleTestEnv,
  scheduleTestViewer as viewer,
} from "./schedule-service-test-fixture";
import { eventLocalTimeEpoch } from "./schedule-time";

beforeEach(prepareScheduleServiceTest);

describe("schedule publication workflows", () => {
  it("keeps the live published programme intact while a published session moves in a draft", async () => {
    const schedule = new ScheduleService(scheduleTestEnv);
    const publicProgramme = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const publishedStartsAt = Date.parse("2027-05-22T13:00:00Z") / 1_000;
    const publishedEndsAt = publishedStartsAt + 3_600;
    await env.DB.batch([
      env.DB.prepare(
        `
          INSERT INTO schedule_versions (
            id, event_id, version_number, name, status, revision, created_by_person_id, created_at, published_at
          ) VALUES ('schedule-test-published', ?, 1, 'Published schedule test', 'published', 1, ?, unixepoch(), unixepoch())
        `,
      ).bind(viewer.eventId, viewer.personId),
      env.DB.prepare(
        `UPDATE schedule_session_contents
            SET content_status = 'approved', approved_by_person_id = ?,
                approved_at = unixepoch(), approval_source = 'editorial'
          WHERE schedule_version_id = 'schedule-test-published'
            AND event_id = ? AND session_id = 'schedule-test-one'`,
      ).bind(viewer.personId, viewer.eventId),
      env.DB.prepare(
        `
          INSERT INTO schedule_entries (
            id, event_id, schedule_version_id, session_id, room_id, starts_at, ends_at, revision, created_at, updated_at
          ) VALUES ('schedule-test-published-entry', ?, 'schedule-test-published', 'schedule-test-one', 'main', ?, ?, 1, unixepoch(), unixepoch())
        `,
      ).bind(viewer.eventId, publishedStartsAt, publishedEndsAt),
      env.DB.prepare(
        "UPDATE sessions SET status = 'published' WHERE id = 'schedule-test-one' AND event_id = ?",
      ).bind(viewer.eventId),
      env.DB.prepare(
        "UPDATE events SET programme_published_at = unixepoch() WHERE id = ? AND organisation_id = ?",
      ).bind(viewer.eventId, viewer.organisationId),
    ]);
    const liveBefore = await publicProgramme.getPublished(
      "future-of-events-2027",
    );
    const sessionBefore = liveBefore?.sessions.find(
      (session) => session.id === "schedule-test-one",
    );
    expect(sessionBefore).toBeDefined();

    const versionId = await schedule.createDraft(viewer);
    const workspace = await schedule.getWorkspace(viewer);
    const draftEntry = workspace.entries.find(
      (entry) => entry.sessionId === "schedule-test-one",
    );
    expect(draftEntry).toBeDefined();
    const movedStartsAt = draftEntry!.startsAt + 6 * 3_600;
    await schedule.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: draftEntry!.roomId,
      startsAt: movedStartsAt,
      endsAt: movedStartsAt + (draftEntry!.endsAt - draftEntry!.startsAt),
    });

    const [sessionRow, draftAfter, liveWhileDraft] = await Promise.all([
      env.DB.prepare(
        "SELECT status FROM sessions WHERE id = ? AND event_id = ?",
      )
        .bind("schedule-test-one", viewer.eventId)
        .first<{ status: string }>(),
      schedule.getWorkspace(viewer),
      publicProgramme.getPublished("future-of-events-2027"),
    ]);
    expect(sessionRow?.status).toBe("published");
    expect(
      draftAfter.entries.find(
        (entry) => entry.sessionId === "schedule-test-one",
      )?.startsAt,
    ).toBe(movedStartsAt);
    expect(liveWhileDraft?.version.id).toBe(liveBefore?.version.id);
    expect(
      liveWhileDraft?.sessions.find(
        (session) => session.id === "schedule-test-one",
      ),
    ).toEqual(sessionBefore);

    const draftSession = draftAfter.sessions.find(
      (session) => session.id === "schedule-test-one",
    )!;
    await schedule.updateSessionContent(
      viewer,
      {
        scheduleVersionId: versionId,
        scheduleRevision: draftAfter.version!.revision,
        sessionId: draftSession.id,
        sessionRevision: draftSession.revision,
        idempotencyKey: crypto.randomUUID(),
        title: "Draft-only replacement title",
        description: "Draft-only replacement description.",
        format: draftSession.format,
        durationMinutes: draftSession.durationMinutes,
        trackId: draftSession.trackId,
        visibility: draftSession.visibility,
        requiredResources: draftSession.requiredResources,
      },
      "admin_ui",
    );
    let [contentDraft, liveWhileContentDraft] = await Promise.all([
      schedule.getWorkspace(viewer),
      publicProgramme.getPublished("future-of-events-2027"),
    ]);
    expect(
      liveWhileContentDraft?.sessions.find(
        (session) => session.id === "schedule-test-one",
      ),
    ).toEqual(sessionBefore);

    const contentReview = await new ContentManagementService(
      scheduleTestEnv,
    ).getSession(viewer, draftSession.id);
    await new ContentManagementService(scheduleTestEnv).changeStatus(viewer, {
      scheduleVersionId: versionId,
      sessionId: draftSession.id,
      scheduleRevision: contentReview.current.scheduleRevision,
      contentRevision: contentReview.current.contentRevision,
      status: "approved",
      confirmed: true,
    });
    contentDraft = await schedule.getWorkspace(viewer);

    await schedule.publish(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: contentDraft.version!.revision,
    });
    const liveAfterPublication = await publicProgramme.getPublished(
      "future-of-events-2027",
    );
    expect(liveAfterPublication?.version.id).toBe(versionId);
    expect(
      liveAfterPublication?.sessions.find(
        (session) => session.id === "schedule-test-one",
      )?.startsAt,
    ).toBe(movedStartsAt);
    expect(
      liveAfterPublication?.sessions.find(
        (session) => session.id === "schedule-test-one",
      ),
    ).toMatchObject({
      title: "Draft-only replacement title",
      description: "Draft-only replacement description.",
    });
  });

  it("blocks a conflict-free version until its public content is approved", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    workspace = await service.getWorkspace(viewer);
    expect(
      workspace.sessions.find((session) => session.id === "schedule-test-one")
        ?.contentStatus,
    ).toBe("draft");
    await expect(
      service.publish(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
      }),
    ).rejects.toThrow(/requires an Approved content snapshot.*draft/i);
    await expect(
      env.DB.prepare("SELECT status FROM schedule_versions WHERE id = ?")
        .bind(versionId)
        .first(),
    ).resolves.toEqual({ status: "draft" });
    await approveScheduledTestContent(versionId);
    workspace = await service.getWorkspace(viewer);
    const publication = await service.publish(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
    });
    const [version, event, audit] = await Promise.all([
      env.DB.prepare(
        "SELECT status, published_at AS publishedAt FROM schedule_versions WHERE id = ?",
      )
        .bind(versionId)
        .first<{ status: string; publishedAt: number | null }>(),
      env.DB.prepare(
        "SELECT programme_published_at AS publishedAt FROM events WHERE id = ?",
      )
        .bind(viewer.eventId)
        .first<{ publishedAt: number | null }>(),
      env.DB.prepare(
        "SELECT action FROM audit_events WHERE event_id = ? AND entity_id = ? AND action = 'schedule.published'",
      )
        .bind(viewer.eventId, versionId)
        .first<{ action: string }>(),
    ]);
    expect(version?.status).toBe("published");
    expect(version?.publishedAt).toBeTypeOf("number");
    expect(event?.publishedAt).toBeTypeOf("number");
    expect(audit?.action).toBe("schedule.published");
    expect(publication.published).toBe(true);
    expect(publication.calendar).toMatchObject({
      status: "queued",
      dispatchError: null,
    });
  });

  it("rejects an unapproved public snapshot at the database publication boundary", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    workspace = await service.getWorkspace(viewer);
    expect(
      workspace.sessions.find((session) => session.id === "schedule-test-one")
        ?.contentStatus,
    ).toBe("draft");

    await expect(
      env.DB.prepare(
        `UPDATE schedule_versions
            SET status = 'published', published_at = unixepoch()
          WHERE id = ? AND event_id = ? AND status = 'draft'`,
      )
        .bind(versionId, viewer.eventId)
        .run(),
    ).rejects.toThrow(/public schedule content must be approved/i);
    await expect(
      env.DB.prepare("SELECT status FROM schedule_versions WHERE id = ?")
        .bind(versionId)
        .first(),
    ).resolves.toEqual({ status: "draft" });
  });

  it("allows confirmed participation while the speaker portal invitation remains pending", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    await env.DB.prepare(
      `UPDATE memberships
          SET accepted_at = NULL, invitation_expires_at = unixepoch() + 3600
        WHERE event_id = ? AND role = 'speaker'
          AND person_id IN (
            SELECT person_id FROM session_speakers
             WHERE event_id = ? AND session_id = 'schedule-test-one'
          )`,
    )
      .bind(viewer.eventId, viewer.eventId)
      .run();
    await approveScheduledTestContent(versionId);
    workspace = await service.getWorkspace(viewer);

    await expect(
      service.publish(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
      }),
    ).resolves.toMatchObject({ published: true });
    await expect(
      env.DB.prepare(
        `SELECT membership.accepted_at AS acceptedAt
           FROM memberships membership
          WHERE membership.event_id = ? AND membership.role = 'speaker'
            AND membership.person_id IN (
              SELECT person_id FROM session_speakers
               WHERE event_id = ? AND session_id = 'schedule-test-one'
            )`,
      )
        .bind(viewer.eventId, viewer.eventId)
        .first(),
    ).resolves.toEqual({ acceptedAt: null });
  });

  it("blocks publication when participation is pending despite accepted portal access", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    await approveScheduledTestContent(versionId);
    await env.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending', participation_confirmed_at = NULL
        WHERE event_id = ? AND session_id = 'schedule-test-one'`,
    )
      .bind(viewer.eventId)
      .run();
    workspace = await service.getWorkspace(viewer);

    await expect(
      service.publish(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
      }),
    ).rejects.toThrow(/must confirm.*awaiting confirmation/i);
    await expect(
      env.DB.prepare(
        `SELECT status FROM schedule_versions WHERE id = ? AND event_id = ?`,
      )
        .bind(versionId, viewer.eventId)
        .first(),
    ).resolves.toEqual({ status: "draft" });
  });

  it("ignores unclaimed applicants who are not linked to the scheduled session", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    await approveScheduledTestContent(versionId);
    const submissionId = `schedule-source-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, submitter_person_id, submitter_email, public_reference,
           title, status, submitted_snapshot_json, submitted_at
         ) VALUES (?, ?, 'person-demo-speaker', 'priya.speaker@example.com', ?,
                   'Accepted source application', 'accepted', '{}', unixepoch())`,
      ).bind(submissionId, viewer.eventId, submissionId),
      env.DB.prepare(
        `UPDATE sessions SET source_submission_id = ?
          WHERE id = 'schedule-test-one' AND event_id = ?`,
      ).bind(submissionId, viewer.eventId),
      env.DB.prepare(
        `INSERT INTO submission_speakers (
           id, event_id, submission_id, email, display_name, position,
           invitation_status, is_primary
         ) VALUES (?, ?, ?, ?, 'Unclaimed applicant', 1, 'pending', 0)`,
      ).bind(
        `schedule-unclaimed-${crypto.randomUUID()}`,
        viewer.eventId,
        submissionId,
        `unclaimed-${crypto.randomUUID()}@example.com`,
      ),
    ]);
    workspace = await service.getWorkspace(viewer);

    await expect(
      service.publish(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
      }),
    ).resolves.toMatchObject({ published: true });
  });

  it("rechecks participation confirmation in the atomic publication write", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    await approveScheduledTestContent(versionId);
    workspace = await service.getWorkspace(viewer);

    let raced = false;
    const racingDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property !== "batch")
          return Reflect.get(target, property, receiver);
        return async (statements: D1PreparedStatement[]) => {
          raced = true;
          await target
            .prepare(
              `UPDATE session_speakers
                  SET participation_status = 'pending',
                      participation_confirmed_at = NULL
                WHERE event_id = ? AND session_id = 'schedule-test-one'`,
            )
            .bind(viewer.eventId)
            .run();
          return target.batch(statements);
        };
      },
    });
    const racingEnv = new Proxy(scheduleTestEnv, {
      get(target, property, receiver) {
        if (property === "DB") return racingDb;
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(
      new ScheduleService(racingEnv).publish(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
      }),
    ).rejects.toThrow(/must confirm.*awaiting confirmation/i);
    expect(raced).toBe(true);
    await expect(
      env.DB.prepare(
        `SELECT status FROM schedule_versions WHERE id = ? AND event_id = ?`,
      )
        .bind(versionId, viewer.eventId)
        .first(),
    ).resolves.toEqual({ status: "draft" });
  });

  it("rechecks exact content approval in the atomic publication write", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    await approveScheduledTestContent(versionId);
    workspace = await service.getWorkspace(viewer);

    let raced = false;
    const racingDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property !== "batch")
          return Reflect.get(target, property, receiver);
        return async (statements: D1PreparedStatement[]) => {
          raced = true;
          await target
            .prepare(
              `UPDATE schedule_session_contents
                  SET content_status = 'in_review',
                      approved_by_person_id = NULL, approved_at = NULL,
                      approval_source = NULL
                WHERE schedule_version_id = ? AND event_id = ?
                  AND session_id = 'schedule-test-one'`,
            )
            .bind(versionId, viewer.eventId)
            .run();
          return target.batch(statements);
        };
      },
    });
    const racingEnv = new Proxy(scheduleTestEnv, {
      get(target, property, receiver) {
        if (property === "DB") return racingDb;
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(
      new ScheduleService(racingEnv).publish(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
      }),
    ).rejects.toThrow(/requires an Approved content snapshot.*in review/i);
    expect(raced).toBe(true);
    await expect(
      env.DB.prepare(
        `SELECT status FROM schedule_versions WHERE id = ? AND event_id = ?`,
      )
        .bind(versionId, viewer.eventId)
        .first(),
    ).resolves.toEqual({ status: "draft" });
  });

  it("rechecks public snapshot approval in the atomic publication write", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    await approveScheduledTestContent(versionId);
    workspace = await service.getWorkspace(viewer);

    let raced = false;
    const racingDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property !== "batch")
          return Reflect.get(target, property, receiver);
        return async (statements: D1PreparedStatement[]) => {
          raced = true;
          await target
            .prepare(
              `UPDATE schedule_session_contents
                  SET content_status = 'draft',
                      approved_by_person_id = NULL,
                      approved_at = NULL,
                      approval_source = NULL
                WHERE schedule_version_id = ? AND event_id = ?
                  AND session_id = 'schedule-test-one'`,
            )
            .bind(versionId, viewer.eventId)
            .run();
          return target.batch(statements);
        };
      },
    });
    const racingEnv = new Proxy(scheduleTestEnv, {
      get(target, property, receiver) {
        if (property === "DB") return racingDb;
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(
      new ScheduleService(racingEnv).publish(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
      }),
    ).rejects.toThrow(/Approved content snapshot.*draft/i);
    expect(raced).toBe(true);
    await expect(
      env.DB.prepare(
        `SELECT status FROM schedule_versions WHERE id = ? AND event_id = ?`,
      )
        .bind(versionId, viewer.eventId)
        .first(),
    ).resolves.toEqual({ status: "draft" });
  });

  it("fails before publication when the required operations Queue binding is absent", async () => {
    const service = new ScheduleService(
      env as unknown as CloudflareEnvironment,
    );
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    workspace = await service.getWorkspace(viewer);

    await expect(
      service.publish(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
      }),
    ).rejects.toThrow(/requires the OPERATIONS_QUEUE binding/i);
    await expect(
      env.DB.prepare(
        `SELECT status FROM schedule_versions WHERE id = ? AND event_id = ?`,
      )
        .bind(versionId, viewer.eventId)
        .first(),
    ).resolves.toEqual({ status: "draft" });
  });

  it("reports a transient Queue send failure honestly after the durable publication commits", async () => {
    const failingQueueEnv = new Proxy(scheduleTestEnv, {
      get(target, property, receiver) {
        if (property === "OPERATIONS_QUEUE")
          return {
            send: async () => {
              throw new Error("temporary Queue transport failure");
            },
          } satisfies Pick<Queue, "send">;
        return Reflect.get(target, property, receiver);
      },
    });
    const service = new ScheduleService(failingQueueEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    workspace = await service.getWorkspace(viewer);
    await approveScheduledTestContent(versionId);

    const result = await service.publish(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
    });
    expect(result.calendar).toMatchObject({
      status: "queue_failed",
      dispatchError: "temporary Queue transport failure",
    });
    await expect(
      env.DB.prepare(
        `SELECT status FROM schedule_versions WHERE id = ? AND event_id = ?`,
      )
        .bind(versionId, viewer.eventId)
        .first(),
    ).resolves.toEqual({ status: "published" });
  });

  it("fails publication before the D1 CAS when Airtable is authoritative but unavailable", async () => {
    const suffix = crypto.randomUUID();
    const eventId = `airtable-schedule-${suffix}`;
    const roomId = `airtable-room-${suffix}`;
    const sessionId = `airtable-session-${suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (
             id, organisation_id, name, slug, timezone, starts_at, ends_at,
             repository_provider, file_policy_json, revision, created_at, updated_at
           ) VALUES (?, ?, 'Airtable schedule test', ?, 'UTC', 4070908800,
                     4070995200, 'd1', ?, 1, unixepoch(), unixepoch())`,
      ).bind(
        eventId,
        viewer.organisationId,
        eventId,
        CANONICAL_EVENT_FILE_POLICY_JSON,
      ),
      env.DB.prepare(
        `INSERT INTO rooms (
             id, event_id, name, capacity, resources_json, position, status
           ) VALUES (?, ?, 'Test room', 100, '[]', 0, 'active')`,
      ).bind(roomId, eventId),
      env.DB.prepare(
        `INSERT INTO sessions (
             id, event_id, title, slug, format, duration_minutes, status,
             visibility, revision, created_at, updated_at
           ) VALUES (?, ?, 'Airtable session', ?, 'presentation', 60,
                     'unscheduled', 'public', 1, unixepoch(), unixepoch())`,
      ).bind(sessionId, eventId, sessionId),
    ]);
    const airtableViewer = { ...viewer, eventId };
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(airtableViewer);
    let workspace = await service.getWorkspace(airtableViewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(airtableViewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId,
      roomId,
      startsAt,
      endsAt: startsAt + 3_600,
    });
    workspace = await service.getWorkspace(airtableViewer);
    await approveScheduledTestContent(versionId, airtableViewer);
    await env.DB.prepare(
      "UPDATE events SET repository_provider = 'airtable' WHERE id = ? AND organisation_id = ?",
    )
      .bind(eventId, viewer.organisationId)
      .run();

    await expect(
      service.publish(airtableViewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
      }),
    ).rejects.toThrow(/configure and validate an airtable repository/i);
    expect(
      await env.DB.prepare(
        "SELECT status FROM schedule_versions WHERE id = ? AND event_id = ?",
      )
        .bind(versionId, eventId)
        .first<{ status: string }>(),
    ).toEqual({ status: "draft" });
  });

  it("treats an expired publication idempotency key as a new command", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    workspace = await service.getWorkspace(viewer);
    const key = `schedule-expired-${crypto.randomUUID()}`;
    const expiredId = `expired-${crypto.randomUUID()}`;
    const actorId = "api_key:schedule-expiry-test";
    await env.DB.prepare(
      `
        INSERT INTO idempotency_records (
          id, organisation_id, event_id, actor_id, scope, idempotency_key,
          request_hash, status, response_status, response_json, expires_at,
          created_at, completed_at
        ) VALUES (?, ?, ?, ?, 'schedule.publish', ?, 'expired-request',
                  'completed', 200, '{"calendarOperationId":"old","changeSequence":1}',
                  unixepoch() - 1, unixepoch() - 2, unixepoch() - 2)
      `,
    )
      .bind(expiredId, viewer.organisationId, viewer.eventId, actorId, key)
      .run();
    await approveScheduledTestContent(versionId);

    await expect(
      service.publish(
        viewer,
        {
          scheduleVersionId: versionId,
          scheduleRevision: workspace.version!.revision,
        },
        { personId: null, actorId },
        { actorId, idempotencyKey: key, requestHash: "replacement-request" },
      ),
    ).resolves.toMatchObject({ published: true, scheduleVersionId: versionId });
    const record = await env.DB.prepare(
      `
        SELECT id, request_hash AS requestHash, expires_at AS expiresAt
          FROM idempotency_records
         WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
           AND scope = 'schedule.publish' AND idempotency_key = ?
      `,
    )
      .bind(viewer.organisationId, viewer.eventId, actorId, key)
      .first<{ id: string; requestHash: string; expiresAt: number }>();
    expect(record?.id).not.toBe(expiredId);
    expect(record?.requestHash).toBe("replacement-request");
    expect(record?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1_000));
  });

  it("rejects publication when Event Setup changes after validation is loaded", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    workspace = await service.getWorkspace(viewer);

    class RacingScheduleService extends ScheduleService {
      override async getWorkspace(
        scope: Pick<Viewer, "organisationId" | "eventId">,
      ) {
        const loaded = await super.getWorkspace(scope);
        await env.DB.prepare(
          `
            UPDATE events SET revision = revision + 1, updated_at = unixepoch()
             WHERE id = ? AND organisation_id = ?
          `,
        )
          .bind(scope.eventId, scope.organisationId)
          .run();
        return loaded;
      }
    }
    const racing = new RacingScheduleService(scheduleTestEnv);
    await approveScheduledTestContent(versionId);
    const input = {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
    };
    const idempotencyKey = `schedule-race-${crypto.randomUUID()}`;
    await expect(
      racing.publish(
        viewer,
        input,
        { personId: null, actorId: "api_key:schedule-race" },
        {
          actorId: "api_key:schedule-race",
          idempotencyKey,
          requestHash: "schedule-race-request-hash",
        },
      ),
    ).rejects.toThrow(/schedule changed/i);
    const version = await env.DB.prepare(
      `
        SELECT status FROM schedule_versions WHERE id = ?
      `,
    )
      .bind(versionId)
      .first<{ status: string }>();
    expect(version?.status).toBe("draft");
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM idempotency_records
            WHERE event_id = ? AND actor_id = 'api_key:schedule-race'
              AND scope = 'schedule.publish' AND idempotency_key = ?`,
      )
        .bind(viewer.eventId, idempotencyKey)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("rechecks missing content snapshots inside the publication transaction", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    workspace = await service.getWorkspace(viewer);

    class MissingSnapshotRacingScheduleService extends ScheduleService {
      override async getWorkspace(
        scope: Pick<Viewer, "organisationId" | "eventId">,
      ) {
        const loaded = await super.getWorkspace(scope);
        await env.DB.prepare(
          `DELETE FROM schedule_session_contents
            WHERE schedule_version_id = ? AND event_id = ?
              AND session_id = 'schedule-test-one'`,
        )
          .bind(versionId, scope.eventId)
          .run();
        return loaded;
      }
    }

    await expect(
      new MissingSnapshotRacingScheduleService(scheduleTestEnv).publish(
        viewer,
        {
          scheduleVersionId: versionId,
          scheduleRevision: workspace.version!.revision,
        },
      ),
    ).rejects.toThrow(
      /missing one or more required frozen session-content snapshots/i,
    );
    await expect(
      env.DB.prepare("SELECT status FROM schedule_versions WHERE id = ?")
        .bind(versionId)
        .first(),
    ).resolves.toEqual({ status: "draft" });
  });

  it("durably queues calendar fan-out and materialises lifecycle operations in the worker", async () => {
    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      DB: env.DB,
      RESEND_API_KEY: "schedule-calendar-test-key",
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => {
          queued.push(message);
        },
      },
    } as unknown as CloudflareEnvironment;
    await env.DB.prepare(
      `
        INSERT OR IGNORE INTO sender_profiles (
          id, event_id, name, from_name, from_email, provider, status, created_at, updated_at
        ) VALUES ('schedule-calendar-sender', ?, 'Schedule calendar sender', 'Future of Events',
                  'calendar@example.com', 'resend', 'verified', unixepoch(), unixepoch())
      `,
    )
      .bind(viewer.eventId)
      .run();
    const service = new ScheduleService(testEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    await env.DB.prepare(
      `UPDATE schedule_session_contents
          SET content_status = 'approved', approved_by_person_id = ?,
              approved_at = unixepoch(), approval_source = 'editorial'
        WHERE schedule_version_id = ? AND event_id = ?
          AND session_id = 'schedule-test-one'`,
    )
      .bind(viewer.personId, versionId, viewer.eventId)
      .run();
    workspace = await service.getWorkspace(viewer);
    const publication = await service.publish(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
    });
    expect(publication.calendar).toMatchObject({
      status: "queued",
      dispatchError: null,
    });
    expect(queued).toEqual([
      expect.objectContaining({
        type: "schedule.calendar_fanout",
        operationId: publication.calendar.operationId,
        scheduleVersionId: versionId,
      }),
    ]);

    const cursorBeforeFanout = await env.DB.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS cursor FROM event_changes WHERE event_id = ?",
    )
      .bind(viewer.eventId)
      .first<{ cursor: number }>();
    const dispatch = await processScheduleCalendarFanout(queued[0], testEnv);
    expect(dispatch?.targetCount).toBeGreaterThan(0);
    expect(dispatch?.failures).toEqual([]);
    expect(dispatch?.queuedCount).toBe(dispatch?.targetCount);
    expect(queued.slice(1)).toHaveLength(dispatch!.targetCount);
    expect(
      queued
        .slice(1)
        .every(
          (message) => (message as { type: string }).type === "calendar.sync",
        ),
    ).toBe(true);
    const persisted = await env.DB.prepare(
      `
        SELECT status, progress_total AS progressTotal, progress_completed AS progressCompleted,
               progress_failed AS progressFailed
          FROM operation_jobs WHERE id = ? AND type = 'schedule.calendar_fanout'
      `,
    )
      .bind(publication.calendar.operationId)
      .first();
    expect(persisted).toEqual({
      status: "completed",
      progressTotal: dispatch!.targetCount,
      progressCompleted: dispatch!.targetCount,
      progressFailed: 0,
    });
    expect(
      await env.DB.prepare(
        `
          SELECT entity_type AS entityType, entity_id AS entityId,
                 change_type AS changeType
            FROM event_changes
           WHERE event_id = ? AND sequence > ?
           ORDER BY sequence DESC LIMIT 1
        `,
      )
        .bind(viewer.eventId, Number(cursorBeforeFanout?.cursor ?? 0))
        .first(),
    ).toEqual({
      entityType: "operation_job",
      entityId: publication.calendar.operationId,
      changeType: "progress",
    });
  });

  it("demotes sessions removed from a later published version and copies snapshot visibility", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const firstVersionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: firstVersionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    workspace = await service.getWorkspace(viewer);
    const firstSession = workspace.sessions.find(
      (session) => session.id === "schedule-test-one",
    )!;
    await service.updateSessionContent(
      viewer,
      {
        scheduleVersionId: firstVersionId,
        scheduleRevision: workspace.version!.revision,
        sessionId: firstSession.id,
        sessionRevision: firstSession.revision,
        idempotencyKey: crypto.randomUUID(),
        title: firstSession.title,
        description: firstSession.description ?? "",
        format: firstSession.format,
        durationMinutes: firstSession.durationMinutes,
        trackId: firstSession.trackId,
        visibility: "public",
        requiredResources: firstSession.requiredResources,
      },
      "admin_ui",
    );
    await approveScheduledTestContent(firstVersionId);
    workspace = await service.getWorkspace(viewer);
    await service.publish(viewer, {
      scheduleVersionId: firstVersionId,
      scheduleRevision: workspace.version!.revision,
    });
    expect(
      await env.DB.prepare(
        "SELECT status, visibility FROM sessions WHERE id = ? AND event_id = ?",
      )
        .bind("schedule-test-one", viewer.eventId)
        .first(),
    ).toEqual({ status: "published", visibility: "public" });

    const secondVersionId = await service.createDraft(viewer);
    workspace = await service.getWorkspace(viewer);
    const publishedEntry = workspace.entries.find(
      (entry) => entry.sessionId === "schedule-test-one",
    )!;
    await service.unassign(viewer, {
      scheduleVersionId: secondVersionId,
      scheduleRevision: workspace.version!.revision,
      entryId: publishedEntry.id,
    });
    workspace = await service.getWorkspace(viewer);
    await service.place(viewer, {
      scheduleVersionId: secondVersionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-two",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    workspace = await service.getWorkspace(viewer);
    const replacement = workspace.sessions.find(
      (session) => session.id === "schedule-test-two",
    )!;
    await service.updateSessionContent(
      viewer,
      {
        scheduleVersionId: secondVersionId,
        scheduleRevision: workspace.version!.revision,
        sessionId: replacement.id,
        sessionRevision: replacement.revision,
        idempotencyKey: crypto.randomUUID(),
        title: replacement.title,
        description: replacement.description ?? "",
        format: replacement.format,
        durationMinutes: replacement.durationMinutes,
        trackId: replacement.trackId,
        visibility: "public",
        requiredResources: replacement.requiredResources,
      },
      "admin_ui",
    );
    await env.DB.prepare(
      `UPDATE sessions SET visibility = 'hidden' WHERE id = ? AND event_id = ?`,
    )
      .bind("schedule-test-two", viewer.eventId)
      .run();
    await approveScheduledTestContent(secondVersionId);
    workspace = await service.getWorkspace(viewer);
    await service.publish(viewer, {
      scheduleVersionId: secondVersionId,
      scheduleRevision: workspace.version!.revision,
    });

    expect(
      await env.DB.prepare(
        "SELECT status FROM sessions WHERE id = ? AND event_id = ?",
      )
        .bind("schedule-test-one", viewer.eventId)
        .first(),
    ).toEqual({ status: "unscheduled" });
    expect(
      await env.DB.prepare(
        "SELECT status, visibility FROM sessions WHERE id = ? AND event_id = ?",
      )
        .bind("schedule-test-two", viewer.eventId)
        .first(),
    ).toEqual({ status: "published", visibility: "public" });
  });

  it("repairs live visibility that a pre-upgrade draft edit diverged from the published snapshot", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const publicProgramme = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    workspace = await service.getWorkspace(viewer);
    const session = workspace.sessions.find(
      (candidate) => candidate.id === "schedule-test-one",
    )!;
    await service.updateSessionContent(
      viewer,
      {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
        sessionId: session.id,
        sessionRevision: session.revision,
        idempotencyKey: crypto.randomUUID(),
        title: session.title,
        description: session.description ?? "",
        format: session.format,
        durationMinutes: session.durationMinutes,
        trackId: session.trackId,
        visibility: "public",
        requiredResources: session.requiredResources,
      },
      "admin_ui",
    );
    await approveScheduledTestContent(versionId);
    workspace = await service.getWorkspace(viewer);
    await service.publish(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
    });

    const before = await env.DB.prepare(
      `SELECT public_projection_revision AS revision FROM events WHERE id = ?`,
    )
      .bind(viewer.eventId)
      .first<{ revision: number }>();
    await env.DB.prepare(
      `UPDATE sessions SET visibility = 'private' WHERE id = ? AND event_id = ?`,
    )
      .bind("schedule-test-one", viewer.eventId)
      .run();
    expect(
      (
        await publicProgramme.getPublished("future-of-events-2027")
      )?.sessions.some((candidate) => candidate.id === "schedule-test-one"),
    ).toBe(false);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id, created_at
         )
         SELECT DISTINCT session.event_id, 'event', session.event_id, 'updated',
                'migration-0044-snapshot-visibility', unixepoch()
           FROM sessions session
           JOIN schedule_versions version
             ON version.event_id = session.event_id
            AND version.status = 'published'
           JOIN schedule_entries entry
             ON entry.event_id = session.event_id
            AND entry.schedule_version_id = version.id
            AND entry.session_id = session.id
           JOIN schedule_session_contents content
             ON content.event_id = session.event_id
            AND content.schedule_version_id = version.id
            AND content.session_id = session.id
          WHERE session.visibility <> content.visibility
            AND session.event_id = ?`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `UPDATE sessions
            SET visibility = (
                  SELECT content.visibility
                    FROM schedule_versions version
                    JOIN schedule_entries entry
                      ON entry.event_id = sessions.event_id
                     AND entry.schedule_version_id = version.id
                     AND entry.session_id = sessions.id
                    JOIN schedule_session_contents content
                      ON content.event_id = sessions.event_id
                     AND content.schedule_version_id = version.id
                     AND content.session_id = sessions.id
                   WHERE version.event_id = sessions.event_id
                     AND version.status = 'published'
                ),
                revision = revision + 1,
                updated_at = unixepoch()
          WHERE event_id = ?
            AND EXISTS (
              SELECT 1
                FROM schedule_versions version
                JOIN schedule_entries entry
                  ON entry.event_id = sessions.event_id
                 AND entry.schedule_version_id = version.id
                 AND entry.session_id = sessions.id
                JOIN schedule_session_contents content
                  ON content.event_id = sessions.event_id
                 AND content.schedule_version_id = version.id
                 AND content.session_id = sessions.id
               WHERE version.event_id = sessions.event_id
                 AND version.status = 'published'
                 AND content.visibility <> sessions.visibility
            )`,
      ).bind(viewer.eventId),
    ]);

    expect(
      await env.DB.prepare(
        "SELECT visibility FROM sessions WHERE id = ? AND event_id = ?",
      )
        .bind("schedule-test-one", viewer.eventId)
        .first(),
    ).toEqual({ visibility: "public" });
    expect(
      (
        await publicProgramme.getPublished("future-of-events-2027")
      )?.sessions.some((candidate) => candidate.id === "schedule-test-one"),
    ).toBe(true);
    const after = await env.DB.prepare(
      `SELECT public_projection_revision AS revision,
              (SELECT COUNT(*) FROM event_changes change
                WHERE change.event_id = events.id
                  AND change.correlation_id =
                      'migration-0044-snapshot-visibility') AS changeCount
         FROM events WHERE id = ?`,
    )
      .bind(viewer.eventId)
      .first<{ revision: number; changeCount: number }>();
    expect(after!.changeCount).toBe(1);
    expect(after!.revision).toBeGreaterThan(before!.revision);
  });
});
