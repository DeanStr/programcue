import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import { processScheduleCalendarFanout } from "../../../workers/communications-queue";
import {
  ScheduleConfigurationError,
  SchedulePlacementBlockedError,
  ScheduleService,
} from "./schedule-service.server";
import { eventLocalTimeEpoch } from "./schedule-time";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM schedule_versions WHERE event_id = ?").bind(
      viewer.eventId,
    ),
    env.DB.prepare(
      "UPDATE events SET programme_published_at = NULL WHERE id = ?",
    ).bind(viewer.eventId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO schedule_policies (event_id) VALUES (?)",
    ).bind(viewer.eventId),
    env.DB.prepare(
      `UPDATE schedule_policies
          SET room_overlap_action = 'block', speaker_overlap_action = 'block',
              exclusive_track_overlap_action = 'warn', capacity_action = 'warn'
        WHERE event_id = ?`,
    ).bind(viewer.eventId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO tracks (id, event_id, name, slug, position) VALUES ('schedule-test-track', ?, 'Operations', 'operations', 0)",
    ).bind(viewer.eventId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO sessions (id, event_id, track_id, title, slug, format, duration_minutes, expected_attendance, status, visibility, revision, created_at, updated_at) VALUES ('schedule-test-one', ?, 'schedule-test-track', 'First test session', 'first-test-session', 'presentation', 60, 100, 'unscheduled', 'public', 1, unixepoch(), unixepoch())`,
    ).bind(viewer.eventId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO sessions (id, event_id, track_id, title, slug, format, duration_minutes, expected_attendance, status, visibility, revision, created_at, updated_at) VALUES ('schedule-test-two', ?, 'schedule-test-track', 'Second test session', 'second-test-session', 'panel', 60, 100, 'unscheduled', 'public', 1, unixepoch(), unixepoch())`,
    ).bind(viewer.eventId),
    env.DB.prepare(
      "UPDATE sessions SET status = 'unscheduled' WHERE event_id = ? AND id IN ('schedule-test-one', 'schedule-test-two')",
    ).bind(viewer.eventId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO session_speakers (session_id, event_id, person_id, position, role_label, visibility) VALUES ('schedule-test-one', ?, 'person-demo-speaker', 0, 'Speaker', 'public')",
    ).bind(viewer.eventId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO session_speakers (session_id, event_id, person_id, position, role_label, visibility) VALUES ('schedule-test-two', ?, 'person-demo-submitter', 0, 'Speaker', 'public')",
    ).bind(viewer.eventId),
  ]);
});

describe("schedule D1 vertical slice", () => {
  it("rejects an event whose required schedule policy record is missing", async () => {
    await env.DB.prepare("DELETE FROM schedule_policies WHERE event_id = ?")
      .bind(viewer.eventId)
      .run();

    await expect(
      new ScheduleService(env as unknown as CloudflareEnvironment).getWorkspace(
        viewer,
      ),
    ).rejects.toBeInstanceOf(ScheduleConfigurationError);
  });

  it("places sessions with optimistic revisions and blocks authoritative conflicts", async () => {
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
    expect(workspace.entries).toHaveLength(1);
    const blockedPlacement = service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-two",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    await expect(blockedPlacement).rejects.toBeInstanceOf(
      SchedulePlacementBlockedError,
    );
    await expect(blockedPlacement).rejects.toMatchObject({
      conflicts: [
        expect.objectContaining({ type: "room", severity: "blocking" }),
      ],
    });
    expect((await service.getWorkspace(viewer)).entries).toHaveLength(1);
  });

  it("excludes cancelled sessions and rejects cancellation racing a placement", async () => {
    const service = new ScheduleService(
      env as unknown as CloudflareEnvironment,
    );
    const versionId = await service.createDraft(viewer);
    const workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );

    class CancellingScheduleService extends ScheduleService {
      override async getWorkspace(
        scope: Pick<Viewer, "organisationId" | "eventId">,
      ) {
        const loaded = await super.getWorkspace(scope);
        await env.DB.prepare(
          "UPDATE sessions SET status = 'cancelled' WHERE id = 'schedule-test-one' AND event_id = ?",
        )
          .bind(scope.eventId)
          .run();
        return loaded;
      }
    }

    await expect(
      new CancellingScheduleService(
        env as unknown as CloudflareEnvironment,
      ).place(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
        sessionId: "schedule-test-one",
        roomId: "main",
        startsAt,
        endsAt: startsAt + 3_600,
      }),
    ).rejects.toThrow(/schedule changed/i);
    expect(
      (await service.getWorkspace(viewer)).sessions.some(
        (session) => session.id === "schedule-test-one",
      ),
    ).toBe(false);
    expect(
      await env.DB.prepare(
        "SELECT status FROM sessions WHERE id = 'schedule-test-one' AND event_id = ?",
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ status: "cancelled" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM schedule_entries WHERE schedule_version_id = ? AND session_id = 'schedule-test-one'",
      )
        .bind(versionId)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("persists one warning for an unordered overlapping entry pair", async () => {
    const service = new ScheduleService(
      env as unknown as CloudflareEnvironment,
    );
    await env.DB.prepare(
      `UPDATE schedule_policies
          SET room_overlap_action = 'warn', speaker_overlap_action = 'allow',
              exclusive_track_overlap_action = 'allow', capacity_action = 'allow'
        WHERE event_id = ?`,
    )
      .bind(viewer.eventId)
      .run();
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    for (const sessionId of ["schedule-test-one", "schedule-test-two"]) {
      await service.place(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
        sessionId,
        roomId: "main",
        startsAt,
        endsAt: startsAt + 3_600,
      });
      workspace = await service.getWorkspace(viewer);
    }
    await service.publish(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
    });

    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM schedule_conflicts
          WHERE event_id = ? AND schedule_version_id = ?
            AND conflict_type = 'room'`,
      )
        .bind(viewer.eventId, versionId)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("returns one winning draft when two administrators create it concurrently", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `
        INSERT INTO schedule_versions (
          id, event_id, version_number, name, status, revision,
          created_by_person_id, created_at, published_at
        ) VALUES (
          'schedule-concurrent-source', ?, 1, 'Published source', 'published',
          1, ?, unixepoch(), unixepoch()
        )
      `,
      ).bind(viewer.eventId, viewer.personId),
      env.DB.prepare(
        `
        INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id,
          starts_at, ends_at, revision, created_at, updated_at
        ) VALUES (
          'schedule-concurrent-source-entry', ?, 'schedule-concurrent-source',
          'schedule-test-one', 'main', 100, 200, 1, unixepoch(), unixepoch()
        )
      `,
      ).bind(viewer.eventId),
    ]);
    let batchCount = 0;
    let releaseBatches!: () => void;
    const bothBatchesReady = new Promise<void>((resolve) => {
      releaseBatches = resolve;
    });
    const sharedDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            batchCount += 1;
            if (batchCount === 2) releaseBatches();
            await bothBatchesReady;
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      DB: sharedDb,
    } as CloudflareEnvironment;

    const [first, second] = await Promise.all([
      new ScheduleService(testEnv).createDraft(viewer),
      new ScheduleService(testEnv).createDraft(viewer),
    ]);

    expect(second).toBe(first);
    expect(
      await env.DB.prepare(
        `
        SELECT COUNT(*) AS draftCount,
               (SELECT COUNT(*) FROM audit_events
                 WHERE event_id = ? AND action = 'schedule.draft.created'
                   AND entity_id = ?) AS auditCount,
               (SELECT COUNT(*) FROM schedule_entries
                 WHERE event_id = ? AND schedule_version_id = ?) AS entryCount
          FROM schedule_versions WHERE event_id = ? AND status = 'draft'
      `,
      )
        .bind(viewer.eventId, first, viewer.eventId, first, viewer.eventId)
        .first(),
    ).toEqual({ draftCount: 1, auditCount: 1, entryCount: 1 });
  });

  it("rebuilds published warnings in a cloned draft and preserves them on publication", async () => {
    const service = new ScheduleService(
      env as unknown as CloudflareEnvironment,
    );
    const eventWorkspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      eventWorkspace.event.startsAt,
      eventWorkspace.event.timezone,
      9,
    );
    await env.DB.batch([
      env.DB.prepare(
        `
        INSERT OR IGNORE INTO rooms (
          id, event_id, name, capacity, status, position
        ) VALUES (
          'schedule-warning-room', ?, 'Warning room', 10, 'active', 99
        )
      `,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `
        INSERT INTO schedule_versions (
          id, event_id, version_number, name, status, revision,
          created_by_person_id, created_at, published_at
        ) VALUES (
          'schedule-warning-source', ?, 1, 'Warning source', 'published', 1,
          ?, unixepoch(), unixepoch()
        )
      `,
      ).bind(viewer.eventId, viewer.personId),
      env.DB.prepare(
        `
        INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id,
          starts_at, ends_at, revision, created_at, updated_at
        ) VALUES (
          'schedule-warning-source-entry', ?, 'schedule-warning-source',
          'schedule-test-one', 'schedule-warning-room', ?, ?, 1, unixepoch(), unixepoch()
        )
      `,
      ).bind(viewer.eventId, startsAt, startsAt + 3_600),
    ]);

    const draftId = await service.createDraft(viewer);
    let draft = await service.getWorkspace(viewer);
    expect(draft.conflicts).toEqual([
      expect.objectContaining({ type: "capacity", severity: "warning" }),
    ]);

    await service.publish(viewer, {
      scheduleVersionId: draftId,
      scheduleRevision: draft.version!.revision,
    });
    draft = await service.getWorkspace(viewer);
    expect(draft.version).toMatchObject({ id: draftId, status: "published" });
    expect(draft.conflicts).toEqual([
      expect.objectContaining({ type: "capacity", severity: "warning" }),
    ]);
  });

  it("removes stale warnings regardless of which side of the conflict is moved", async () => {
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
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-two",
      roomId: "301a",
      startsAt: startsAt + 3_600,
      endsAt: startsAt + 7_200,
    });
    workspace = await service.getWorkspace(viewer);
    const first = workspace.entries.find(
      (entry) => entry.sessionId === "schedule-test-one",
    )!;
    const second = workspace.entries.find(
      (entry) => entry.sessionId === "schedule-test-two",
    )!;
    await env.DB.prepare(
      `
      INSERT INTO schedule_conflicts (
        id, event_id, schedule_version_id, conflict_type, severity, fingerprint,
        primary_entry_id, conflicting_entry_id, details_json
      ) VALUES ('stale-secondary-warning', ?, ?, 'track', 'warning', 'stale-secondary-warning', ?, ?, ?)
    `,
    )
      .bind(
        viewer.eventId,
        versionId,
        first.id,
        second.id,
        JSON.stringify({ message: "Stale warning" }),
      )
      .run();
    expect((await service.getWorkspace(viewer)).conflicts).toHaveLength(1);

    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-two",
      roomId: "301a",
      startsAt: startsAt + 7_200,
      endsAt: startsAt + 10_800,
    });
    expect((await service.getWorkspace(viewer)).conflicts).toEqual([]);
  });

  it("keeps the live published programme intact while a published session moves in a draft", async () => {
    const schedule = new ScheduleService(
      env as unknown as CloudflareEnvironment,
    );
    const publicProgramme = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const publishedStartsAt = Date.parse("2025-05-20T13:00:00Z") / 1_000;
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
      "future-of-events-2025",
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
      publicProgramme.getPublished("future-of-events-2025"),
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

    await schedule.publish(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: draftAfter.version!.revision,
    });
    const liveAfterPublication = await publicProgramme.getPublished(
      "future-of-events-2025",
    );
    expect(liveAfterPublication?.version.id).toBe(versionId);
    expect(
      liveAfterPublication?.sessions.find(
        (session) => session.id === "schedule-test-one",
      )?.startsAt,
    ).toBe(movedStartsAt);
  });

  it("publishes a conflict-free version and retains an audit event", async () => {
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
      status: "queue_failed",
      dispatchError: expect.stringContaining("OPERATIONS_QUEUE"),
    });
  });

  it("treats an expired publication idempotency key as a new command", async () => {
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
    const racing = new RacingScheduleService(
      env as unknown as CloudflareEnvironment,
    );
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
});
