import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Viewer } from "~/platform/auth/authorize.server";

import {
  ScheduleConfigurationError,
  ScheduleService,
} from "./schedule-service.server";
import { eventLocalTimeEpoch } from "./schedule-time";
import {
  approveScheduledTestContent,
  prepareScheduleServiceTest,
  scheduleTestEnv,
  scheduleTestViewer as viewer,
} from "./schedule-service-test-fixture";

beforeEach(prepareScheduleServiceTest);

describe("schedule content and draft workflows", () => {
  it("preserves speaker names containing the former aggregate delimiter", async () => {
    const original = await env.DB.prepare(
      "SELECT display_name AS displayName FROM people WHERE id = 'person-demo-speaker'",
    ).first<{ displayName: string }>();
    if (!original) throw new Error("The schedule test speaker is missing.");

    const displayName = 'Priya || "Operations"';
    try {
      await env.DB.prepare(
        "UPDATE people SET display_name = ? WHERE id = 'person-demo-speaker'",
      )
        .bind(displayName)
        .run();

      const workspace = await new ScheduleService(scheduleTestEnv).getWorkspace(
        viewer,
      );
      const session = workspace.sessions.find(
        (candidate) => candidate.id === "schedule-test-one",
      );
      expect(session).toMatchObject({
        speakerIds: ["person-demo-speaker"],
        speakerNames: [displayName],
      });
    } finally {
      await env.DB.prepare(
        "UPDATE people SET display_name = ? WHERE id = 'person-demo-speaker'",
      )
        .bind(original.displayName)
        .run();
    }
  });

  it("rejects an active draft with any missing content snapshot", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    await env.DB.prepare(
      `DELETE FROM schedule_session_contents
        WHERE schedule_version_id = ? AND event_id = ?
          AND session_id = 'schedule-test-two'`,
    )
      .bind(versionId, viewer.eventId)
      .run();

    await expect(service.getWorkspace(viewer)).rejects.toThrow(
      /missing one or more required frozen session-content snapshots/i,
    );
  });

  it("autosaves revisioned session content once and replays the exact idempotent result", async () => {
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
    const session = workspace.sessions.find(
      (candidate) => candidate.id === "schedule-test-one",
    )!;
    const idempotencyKey = crypto.randomUUID();
    const input = {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: session.id,
      sessionRevision: session.revision,
      idempotencyKey,
      title: "A frozen draft title",
      description: "The exact public and calendar description.",
      format: "presentation",
      durationMinutes: 45,
      trackId: "schedule-test-track",
      visibility: "public",
      requiredResources: [],
    };

    const first = await service.updateSessionContent(viewer, input);
    const replay = await service.updateSessionContent(viewer, input);
    expect(replay).toEqual(first);
    workspace = await service.getWorkspace(viewer);
    expect(
      workspace.sessions.find((candidate) => candidate.id === session.id),
    ).toMatchObject({
      title: input.title,
      description: input.description,
      durationMinutes: 45,
      trackId: "schedule-test-track",
      trackName: "Operations",
      trackExclusive: false,
      revision: first.revision,
    });
    expect(
      workspace.entries.find((entry) => entry.sessionId === session.id),
    ).toMatchObject({ startsAt, endsAt: startsAt + 45 * 60 });
    expect(
      await env.DB.prepare(
        `SELECT title, description, duration_minutes AS durationMinutes,
                  last_operation_id AS lastOperationId,
                  content_status AS contentStatus,
                  content_revision AS contentRevision
             FROM schedule_session_contents
            WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?`,
      )
        .bind(versionId, viewer.eventId, session.id)
        .first(),
    ).toMatchObject({
      title: input.title,
      description: input.description,
      durationMinutes: 45,
      lastOperationId: expect.any(String),
      contentStatus: "draft",
      contentRevision: 2,
    });
    expect(first).toMatchObject({ contentStatus: "draft", contentRevision: 2 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM session_content_revisions
          WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?`,
      )
        .bind(versionId, viewer.eventId, session.id)
        .first(),
    ).toEqual({ count: 2 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
            WHERE event_id = ? AND entity_id = ?
              AND action = 'session.content.updated'`,
      )
        .bind(viewer.eventId, session.id)
        .first(),
    ).toEqual({ count: 1 });
    await expect(
      service.updateSessionContent(viewer, {
        ...input,
        title: "A different payload with the same key",
      }),
    ).rejects.toThrow(/already used for different content/i);
  });

  it("fails before saving content when the selected track is unavailable", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    const workspace = await service.getWorkspace(viewer);
    const session = workspace.sessions.find(
      (candidate) => candidate.id === "schedule-test-one",
    )!;

    await expect(
      service.updateSessionContent(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
        sessionId: session.id,
        sessionRevision: session.revision,
        idempotencyKey: crypto.randomUUID(),
        title: "Unavailable track",
        description: "This content must not be persisted.",
        format: "presentation",
        durationMinutes: 45,
        trackId: "missing-track",
        visibility: "public",
        requiredResources: [],
      }),
    ).rejects.toBeInstanceOf(ScheduleConfigurationError);
    expect(
      (await service.getWorkspace(viewer)).sessions.find(
        (candidate) => candidate.id === session.id,
      ),
    ).toMatchObject({
      title: session.title,
      revision: session.revision,
      trackId: session.trackId,
    });
  });

  it("keeps schedule notes revisioned, idempotent and immutable after publication", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const idempotencyKey = crypto.randomUUID();
    const input = {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      idempotencyKey,
      notes: "Hold room 301A for the production rehearsal.",
    };
    const first = await service.updateScheduleNotes(viewer, input);
    await expect(service.updateScheduleNotes(viewer, input)).resolves.toEqual(
      first,
    );
    workspace = await service.getWorkspace(viewer);
    expect(workspace.version).toMatchObject({
      id: versionId,
      notes: input.notes,
      revision: first.scheduleRevision,
    });
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
    await service.publish(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
    });
    workspace = await service.getWorkspace(viewer);
    await expect(
      service.updateScheduleNotes(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
        idempotencyKey: crypto.randomUUID(),
        notes: "This must not mutate the published version.",
      }),
    ).rejects.toThrow(/only be edited on an active draft/i);
    expect(
      await env.DB.prepare(
        "SELECT notes FROM schedule_versions WHERE id = ? AND event_id = ?",
      )
        .bind(versionId, viewer.eventId)
        .first(),
    ).toEqual({ notes: input.notes });

    const nextDraftId = await service.createDraft(viewer);
    expect(nextDraftId).not.toBe(versionId);
    expect((await service.getWorkspace(viewer)).version).toMatchObject({
      id: nextDraftId,
      status: "draft",
      notes: input.notes,
    });
  });

  it("updates every schedule policy with a revision guard and serializes publication", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    await service.createDraft(viewer);
    const before = await service.getWorkspace(viewer);
    await service.updatePolicies(viewer, {
      revision: before.policyRevision,
      roomAction: "warn",
      speakerAction: "block",
      resourceAction: "warn",
      trackAction: "allow",
      boundaryAction: "block",
      capacityAction: "block",
      minimumTurnaroundMinutes: 15,
    });
    const after = await service.getWorkspace(viewer);
    expect(after.policyRevision).toBe(before.policyRevision + 1);
    expect(after.event.revision).toBe(before.event.revision + 1);
    expect(after.version?.revision).toBe(before.version!.revision + 1);
    expect(after.policies).toEqual({
      room: "warn",
      speaker: "block",
      resource: "warn",
      track: "ignore",
      boundary: "block",
      capacity: "block",
      minimumTurnaroundMinutes: 15,
    });
    await expect(
      service.updatePolicies(viewer, {
        revision: before.policyRevision,
        roomAction: "block",
        speakerAction: "block",
        resourceAction: "block",
        trackAction: "block",
        boundaryAction: "block",
        capacityAction: "block",
        minimumTurnaroundMinutes: 0,
      }),
    ).rejects.toThrow(/schedule changed/i);
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
    const service = new ScheduleService(scheduleTestEnv);
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
    await approveScheduledTestContent(versionId);
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
    await expect(
      service.getConflictedSessionIds(viewer, versionId),
    ).resolves.toEqual(["schedule-test-one", "schedule-test-two"]);
    await expect(
      service.getConflictedSessionIds(
        { ...viewer, organisationId: "org-not-authorised" },
        versionId,
      ),
    ).rejects.toMatchObject({ status: 404 });
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
    const service = new ScheduleService(scheduleTestEnv);
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

    await approveScheduledTestContent(draftId);
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
});
