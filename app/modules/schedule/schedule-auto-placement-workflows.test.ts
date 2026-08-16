import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Viewer } from "~/platform/auth/authorize.server";

import {
  ScheduleNotFoundError,
  ScheduleIdempotencyConflictError,
  ScheduleRevisionConflictError,
  ScheduleService,
} from "./schedule-service.server";
import { eventLocalTimeEpoch } from "./schedule-time";
import { autoPlacementRequestHash } from "./schedule-auto-placement";
import {
  autoPlacementD1StatementCount,
  MAX_AUTO_PLACEMENT_D1_STATEMENTS,
} from "./schedule-auto-placement-workflow.server";
import {
  prepareScheduleServiceTest,
  scheduleTestEnv,
  scheduleTestViewer as viewer,
} from "./schedule-service-test-fixture";

async function resetAutoPlacementSessions() {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM session_speakers
        WHERE event_id = ? AND session_id IN ('schedule-test-one', 'schedule-test-two')`,
    ).bind(viewer.eventId),
    env.DB.prepare(
      `UPDATE sessions
          SET track_id = 'schedule-test-track', format = 'presentation',
              duration_minutes = 60, expected_attendance = 100,
              required_resources_json = '[]', status = 'unscheduled'
        WHERE event_id = ? AND id IN ('schedule-test-one', 'schedule-test-two')`,
    ).bind(viewer.eventId),
    env.DB.prepare(
      `INSERT INTO session_speakers
         (session_id, event_id, person_id, position, role_label,
          participation_status, participation_confirmed_at, visibility)
       VALUES ('schedule-test-one', ?, 'person-demo-speaker', 0, 'Speaker', 'confirmed', unixepoch(), 'public'),
              ('schedule-test-two', ?, 'person-demo-submitter', 0, 'Speaker', 'confirmed', unixepoch(), 'public')`,
    ).bind(viewer.eventId, viewer.eventId),
  ]);
}

beforeEach(async () => {
  await prepareScheduleServiceTest();
  await resetAutoPlacementSessions();
});

async function createDraftAndPreview(
  service = new ScheduleService(scheduleTestEnv),
) {
  await service.createDraft(viewer);
  return { service, preview: await service.previewAutoPlacement(viewer) };
}

describe("schedule auto-placement workflow", () => {
  it("places multiple unscheduled sessions atomically and leaves the schedule as a draft", async () => {
    const { service, preview } = await createDraftAndPreview();

    expect(preview.sessionRevisions.map((item) => item.sessionId)).toEqual([
      "schedule-test-one",
      "schedule-test-two",
    ]);
    expect(preview.placements).toHaveLength(2);
    expect(preview.unplaced).toEqual([]);

    const result = await service.confirmAutoPlacement(viewer, preview);

    expect(result.appliedCount).toBe(2);
    expect(result.unplacedCount).toBe(0);
    expect(result.scheduleRevision).toBe(preview.scheduleRevision + 1);
    const workspace = await service.getWorkspace(viewer);
    expect(workspace.version).toMatchObject({
      id: preview.scheduleVersionId,
      status: "draft",
      revision: result.scheduleRevision,
    });
    expect(workspace.entries.map((entry) => entry.sessionId).sort()).toEqual([
      "schedule-test-one",
      "schedule-test-two",
    ]);
    expect(
      await env.DB.prepare(
        "SELECT programme_published_at AS publishedAt FROM events WHERE id = ? AND organisation_id = ?",
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first(),
    ).toEqual({ publishedAt: null });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM schedule_versions WHERE event_id = ? AND status = 'published'",
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("applies only the selected deterministic placements and leaves exclusions unscheduled", async () => {
    const { service, preview } = await createDraftAndPreview();
    const selectedSessionId = preview.placements[0]!.sessionId;
    const excludedSessionId = preview.placements[1]!.sessionId;
    const subset = { ...preview, selectedSessionIds: [selectedSessionId] };

    const result = await service.confirmAutoPlacement(viewer, subset);

    expect(result).toMatchObject({
      appliedCount: 1,
      excludedCount: 1,
      unplacedCount: 0,
    });
    const workspace = await service.getWorkspace(viewer);
    expect(workspace.entries.map((entry) => entry.sessionId)).toContain(
      selectedSessionId,
    );
    expect(workspace.entries.map((entry) => entry.sessionId)).not.toContain(
      excludedSessionId,
    );
    expect(
      workspace.sessions.find((session) => session.id === excludedSessionId)
        ?.status,
    ).toBe("unscheduled");
    const audit = await env.DB.prepare(
      `SELECT metadata_json AS metadataJson FROM audit_events
        WHERE event_id = ? AND action = 'schedule.auto_place.confirmed'
          AND entity_id = ? AND json_extract(metadata_json, '$.appliedCount') = 1
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(viewer.eventId, preview.scheduleVersionId)
      .first<{ metadataJson: string }>();
    expect(JSON.parse(audit!.metadataJson).excludedSessionIds).toEqual([
      excludedSessionId,
    ]);

    await expect(
      service.confirmAutoPlacement(viewer, {
        ...preview,
        selectedSessionIds: [excludedSessionId],
      }),
    ).rejects.toBeInstanceOf(ScheduleIdempotencyConflictError);
  });

  it("hashes a selected placement set independently of checkbox order", async () => {
    const { preview } = await createDraftAndPreview();
    const selectedSessionIds = preview.placements.map(
      (placement) => placement.sessionId,
    );

    await expect(
      autoPlacementRequestHash({ ...preview, selectedSessionIds }),
    ).resolves.toBe(
      await autoPlacementRequestHash({
        ...preview,
        selectedSessionIds: [...selectedSessionIds].reverse(),
      }),
    );
  });

  it("confirms a larger proposal without exceeding D1 query parameters", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE numbers(n) AS (
         SELECT 1
         UNION ALL
         SELECT n + 1 FROM numbers WHERE n < 43
       )
       INSERT INTO sessions (
         id, event_id, title, slug, format, duration_minutes,
         expected_attendance, status, visibility, revision, created_at, updated_at
       )
       SELECT 'auto-parameter-' || n, ?, 'Auto parameter session ' || n,
              'auto-parameter-' || n, 'presentation', 60, 100,
              'unscheduled', 'public', 1, unixepoch(), unixepoch()
         FROM numbers`,
    )
      .bind(viewer.eventId)
      .run();

    try {
      const { service, preview } = await createDraftAndPreview();
      expect(preview.sessionRevisions).toHaveLength(45);
      expect(preview.placements).toHaveLength(45);

      const result = await service.confirmAutoPlacement(viewer, preview);

      expect(result.appliedCount).toBe(45);
    } finally {
      await env.DB.prepare(
        "DELETE FROM sessions WHERE event_id = ? AND id LIKE 'auto-parameter-%'",
      )
        .bind(viewer.eventId)
        .run();
    }
  });

  it("allows a safe selected subset when the full preview exceeds the atomic statement limit", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE schedule_policies
            SET room_overlap_action = 'warn', speaker_overlap_action = 'warn'
          WHERE event_id = ?`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `WITH RECURSIVE numbers(n) AS (
           SELECT 1
           UNION ALL
           SELECT n + 1 FROM numbers WHERE n < 43
         )
         INSERT INTO sessions (
           id, event_id, track_id, title, slug, format, duration_minutes,
           expected_attendance, status, visibility, revision, created_at, updated_at
         )
         SELECT 'auto-subset-limit-' || n, ?, 'schedule-test-track',
                'Auto subset limit session ' || n, 'auto-subset-limit-' || n,
                'presentation', 60, 100, 'unscheduled', 'public', 1,
                unixepoch(), unixepoch()
           FROM numbers`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_confirmed_at, visibility
         )
         SELECT id, event_id, 'person-demo-speaker', 0, 'Speaker',
                'confirmed', unixepoch(), 'public'
           FROM sessions
          WHERE event_id = ? AND id LIKE 'auto-subset-limit-%'`,
      ).bind(viewer.eventId),
    ]);

    try {
      const { service, preview } = await createDraftAndPreview();
      expect(autoPlacementD1StatementCount(preview)).toBeGreaterThan(
        MAX_AUTO_PLACEMENT_D1_STATEMENTS,
      );
      await expect(
        service.confirmAutoPlacement(viewer, preview),
      ).rejects.toThrow(/select fewer proposed placements/i);
      const selectedSessionId = preview.placements[0]!.sessionId;

      const result = await service.confirmAutoPlacement(viewer, {
        ...preview,
        selectedSessionIds: [selectedSessionId],
      });

      expect(result).toMatchObject({
        appliedCount: 1,
        excludedCount: preview.placements.length - 1,
      });
    } finally {
      await env.DB.prepare(
        "DELETE FROM sessions WHERE event_id = ? AND id LIKE 'auto-subset-limit-%'",
      )
        .bind(viewer.eventId)
        .run();
    }
  });

  it("respects an existing room conflict and does not move the existing session", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      7,
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
    const existing = workspace.entries.find(
      (entry) => entry.sessionId === "schedule-test-one",
    )!;
    const preview = await service.previewAutoPlacement(viewer);

    const result = await service.confirmAutoPlacement(viewer, preview);

    expect(result.appliedCount).toBe(1);
    expect(result.unplacedCount).toBe(0);
    const after = await service.getWorkspace(viewer);
    expect(after.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: existing.id,
          sessionId: "schedule-test-one",
          roomId: "main",
          startsAt,
          endsAt: startsAt + 3_600,
        }),
      ]),
    );
  });

  it("keeps an impossible session unplaced and returns its blocking reason", async () => {
    await env.DB.prepare(
      `UPDATE sessions
          SET required_resources_json = '["lighting desk"]'
        WHERE id = 'schedule-test-one' AND event_id = ?`,
    )
      .bind(viewer.eventId)
      .run();
    const { service, preview } = await createDraftAndPreview();

    const unplaced = preview.unplaced.find(
      (item) => item.sessionId === "schedule-test-one",
    );
    expect(unplaced?.reason).toMatch(/not configured/i);

    const result = await service.confirmAutoPlacement(viewer, preview);

    expect(result.appliedCount).toBe(1);
    expect(result.unplacedCount).toBe(1);
    const workspace = await service.getWorkspace(viewer);
    expect(
      workspace.sessions.find((session) => session.id === "schedule-test-one")
        ?.status,
    ).toBe("unscheduled");
    expect(
      workspace.entries.some(
        (entry) => entry.sessionId === "schedule-test-one",
      ),
    ).toBe(false);
  });

  it("requires a draft and rejects confirmation after the version becomes read-only", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    await expect(service.previewAutoPlacement(viewer)).rejects.toBeInstanceOf(
      ScheduleNotFoundError,
    );
    const versionId = await service.createDraft(viewer);
    const preview = await service.previewAutoPlacement(viewer);
    await env.DB.prepare(
      "UPDATE schedule_versions SET status = 'published', published_at = unixepoch() WHERE id = ? AND event_id = ?",
    )
      .bind(versionId, viewer.eventId)
      .run();

    await expect(
      service.confirmAutoPlacement(viewer, preview),
    ).rejects.toBeInstanceOf(ScheduleNotFoundError);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM schedule_entries WHERE schedule_version_id = ?",
      )
        .bind(versionId)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("fails preview explicitly when the unscheduled session count exceeds the confirmation limit", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE numbers(n) AS (
         SELECT 1
         UNION ALL
         SELECT n + 1 FROM numbers WHERE n < 499
       )
       INSERT INTO sessions (
         id, event_id, track_id, title, slug, format, duration_minutes,
         status, visibility, revision, created_at, updated_at
       )
       SELECT 'auto-limit-' || n, ?, 'schedule-test-track',
              'Auto limit session ' || n, 'auto-limit-' || n, 'presentation',
              60, 'unscheduled', 'public', 1, unixepoch(), unixepoch()
         FROM numbers`,
    )
      .bind(viewer.eventId)
      .run();

    try {
      const service = new ScheduleService(scheduleTestEnv);
      await service.createDraft(viewer);
      await expect(service.previewAutoPlacement(viewer)).rejects.toMatchObject({
        name: "ScheduleConfigurationError",
        message: expect.stringMatching(/at most 500 unscheduled sessions/i),
      });
    } finally {
      await env.DB.prepare(
        "DELETE FROM sessions WHERE event_id = ? AND id LIKE 'auto-limit-%'",
      )
        .bind(viewer.eventId)
        .run();
    }
  });

  it("rejects a stale schedule revision before applying any proposal", async () => {
    const { service, preview } = await createDraftAndPreview();
    await env.DB.prepare(
      "UPDATE schedule_versions SET revision = revision + 1 WHERE id = ? AND event_id = ?",
    )
      .bind(preview.scheduleVersionId, viewer.eventId)
      .run();

    await expect(
      service.confirmAutoPlacement(viewer, preview),
    ).rejects.toMatchObject({
      name: "ScheduleRevisionConflictError",
      message: expect.stringMatching(/fresh preview/i),
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM schedule_entries WHERE schedule_version_id = ?",
      )
        .bind(preview.scheduleVersionId)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("uses the session guards for atomic failure when a session changes after preview", async () => {
    const base = new ScheduleService(scheduleTestEnv);
    await base.createDraft(viewer);
    const preview = await base.previewAutoPlacement(viewer);
    let shouldRace = true;
    class RacingScheduleService extends ScheduleService {
      override async getWorkspace(
        scope: Pick<Viewer, "organisationId" | "eventId">,
      ) {
        const loaded = await super.getWorkspace(scope);
        if (shouldRace) {
          shouldRace = false;
          await env.DB.prepare(
            `UPDATE sessions SET revision = revision + 1
              WHERE id = 'schedule-test-two' AND event_id = ?`,
          )
            .bind(viewer.eventId)
            .run();
        }
        return loaded;
      }
    }

    const racing = new RacingScheduleService(scheduleTestEnv);
    await expect(
      racing.confirmAutoPlacement(viewer, preview),
    ).rejects.toMatchObject({
      name: "ScheduleRevisionConflictError",
      message: expect.stringMatching(/changed while auto-place/i),
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM schedule_entries WHERE schedule_version_id = ?",
      )
        .bind(preview.scheduleVersionId)
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM idempotency_records
          WHERE event_id = ? AND scope = 'schedule.auto_place'
            AND idempotency_key = ?`,
      )
        .bind(viewer.eventId, preview.idempotencyKey)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("replays confirmation idempotently without duplicating placements", async () => {
    const { service, preview } = await createDraftAndPreview();

    const first = await service.confirmAutoPlacement(viewer, preview);
    const replay = await service.confirmAutoPlacement(viewer, preview);

    expect(replay).toEqual(first);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM schedule_entries
          WHERE schedule_version_id = ? AND session_id IN ('schedule-test-one', 'schedule-test-two')`,
      )
        .bind(preview.scheduleVersionId)
        .first(),
    ).toEqual({ count: 2 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE event_id = ? AND action = 'schedule.auto_place.confirmed'
            AND entity_id = ?`,
      )
        .bind(viewer.eventId, preview.scheduleVersionId)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("enforces organisation and event isolation for confirmation", async () => {
    const { service, preview } = await createDraftAndPreview();
    const wrongOrganisation = {
      ...viewer,
      organisationId: "organisation-not-authorised",
    } satisfies Viewer;
    const wrongEvent = {
      ...viewer,
      eventId: "event-not-authorised",
    } satisfies Viewer;

    await expect(
      service.confirmAutoPlacement(wrongOrganisation, preview),
    ).rejects.toThrow(/authorised organisation/i);
    await expect(
      service.confirmAutoPlacement(wrongEvent, preview),
    ).rejects.toThrow(/authorised organisation/i);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM schedule_entries WHERE schedule_version_id = ?",
      )
        .bind(preview.scheduleVersionId)
        .first(),
    ).toEqual({ count: 0 });
  });
});
