import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import { processScheduleCalendarFanout } from "../../../workers/communications-queue";
import {
  ScheduleConfigurationError,
  ScheduleIdempotencyConflictError,
  SchedulePlacementBlockedError,
  SchedulePublicationBlockedError,
  ScheduleRevisionConflictError,
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

const scheduleTestEnv = new Proxy(env as unknown as CloudflareEnvironment, {
  get(target, property, receiver) {
    if (property === "OPERATIONS_QUEUE")
      return {
        send: async () => ({
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        }),
      } satisfies Pick<Queue, "send">;
    return Reflect.get(target, property, receiver);
  },
});

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
              required_resource_overlap_action = 'block',
              exclusive_track_overlap_action = 'warn',
              event_boundary_action = 'block', capacity_action = 'warn',
              minimum_turnaround_minutes = 0
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
      `UPDATE sessions
          SET status = 'unscheduled', required_resources_json = '[]'
        WHERE event_id = ?
          AND id IN ('schedule-test-one', 'schedule-test-two')`,
    ).bind(viewer.eventId),
    env.DB.prepare(
      `UPDATE rooms SET resources_json = '[]'
        WHERE event_id = ? AND id IN ('main', '301a')`,
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

  it("rejects a placement when Event Setup changes after conflict validation", async () => {
    const service = new ScheduleService(
      env as unknown as CloudflareEnvironment,
    );
    await env.DB.prepare(
      "UPDATE schedule_policies SET capacity_action = 'block' WHERE event_id = ?",
    )
      .bind(viewer.eventId)
      .run();
    const versionId = await service.createDraft(viewer);
    const workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );

    class RacingScheduleService extends ScheduleService {
      override async getWorkspace(
        scope: Pick<Viewer, "organisationId" | "eventId">,
      ) {
        const loaded = await super.getWorkspace(scope);
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE events
                SET revision = revision + 1, updated_at = unixepoch()
              WHERE id = ? AND organisation_id = ?`,
          ).bind(scope.eventId, scope.organisationId),
          env.DB.prepare(
            "UPDATE rooms SET capacity = 1 WHERE id = 'main' AND event_id = ?",
          ).bind(scope.eventId),
        ]);
        return loaded;
      }
    }

    await expect(
      new RacingScheduleService(env as unknown as CloudflareEnvironment).place(
        viewer,
        {
          scheduleVersionId: versionId,
          scheduleRevision: workspace.version!.revision,
          sessionId: "schedule-test-one",
          roomId: "main",
          startsAt,
          endsAt: startsAt + 3_600,
        },
      ),
    ).rejects.toBeInstanceOf(ScheduleRevisionConflictError);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM schedule_entries WHERE schedule_version_id = ?",
      )
        .bind(versionId)
        .first(),
    ).toEqual({ count: 0 });

    const current = await service.getWorkspace(viewer);
    await expect(
      service.place(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: current.version!.revision,
        sessionId: "schedule-test-one",
        roomId: "main",
        startsAt,
        endsAt: startsAt + 3_600,
      }),
    ).rejects.toBeInstanceOf(SchedulePlacementBlockedError);
    await env.DB.prepare(
      "UPDATE rooms SET capacity = ? WHERE id = 'main' AND event_id = ?",
    )
      .bind(
        workspace.rooms.find((room) => room.id === "main")!.capacity,
        viewer.eventId,
      )
      .run();
  });

  it("previews Event Setup conflicts with the same rules used by publication", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    await env.DB.prepare(
      "UPDATE schedule_policies SET capacity_action = 'block' WHERE event_id = ?",
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
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    const originalCapacity = workspace.rooms.find(
      (room) => room.id === "main",
    )!.capacity;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE events
            SET revision = revision + 1, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?`,
      ).bind(viewer.eventId, viewer.organisationId),
      env.DB.prepare(
        "UPDATE rooms SET capacity = 1 WHERE id = 'main' AND event_id = ?",
      ).bind(viewer.eventId),
    ]);

    try {
      workspace = await service.getWorkspace(viewer);
      expect(workspace.conflicts).toEqual([]);
      expect(workspace.publicationConflicts).toEqual([
        expect.objectContaining({ type: "capacity", severity: "blocking" }),
      ]);
      const publication = service.publish(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
      });
      await expect(publication).rejects.toBeInstanceOf(
        SchedulePublicationBlockedError,
      );
      await expect(publication).rejects.toMatchObject({
        conflicts: workspace.publicationConflicts,
      });
    } finally {
      await env.DB.prepare(
        "UPDATE rooms SET capacity = ? WHERE id = 'main' AND event_id = ?",
      )
        .bind(originalCapacity, viewer.eventId)
        .run();
    }
  });

  it("durably replays one authenticated assistant placement across concurrent retries", async () => {
    const firstService = new ScheduleService(
      env as unknown as CloudflareEnvironment,
    );
    const secondService = new ScheduleService(
      env as unknown as CloudflareEnvironment,
    );
    const versionId = await firstService.createDraft(viewer);
    const workspace = await firstService.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    const input = {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    };
    const command = {
      actorId: `assistant:${viewer.personId}`,
      idempotencyKey: `assistant:${crypto.randomUUID()}`,
      requestHash: "a".repeat(64),
    };

    const [first, replay] = await Promise.all([
      firstService.place(viewer, input, command),
      secondService.place(viewer, input, command),
    ]);
    expect(replay).toEqual(first);
    expect(first.scheduleRevision).toBe(input.scheduleRevision + 1);
    expect((await firstService.getWorkspace(viewer)).entries).toEqual([
      expect.objectContaining({
        id: first.entryId,
        sessionId: input.sessionId,
        startsAt,
      }),
    ]);
    expect(
      await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_events
             WHERE event_id = ? AND action = 'schedule.entry.placed'
               AND entity_id = ?) AS audits,
           (SELECT COUNT(*) FROM idempotency_records
             WHERE event_id = ? AND actor_id = ?
               AND scope = 'schedule.entry.place' AND idempotency_key = ?
               AND status = 'completed') AS commands`,
      )
        .bind(
          viewer.eventId,
          first.entryId,
          viewer.eventId,
          command.actorId,
          command.idempotencyKey,
        )
        .first(),
    ).toEqual({ audits: 1, commands: 1 });

    const reusedCommand = firstService.place(viewer, input, {
      ...command,
      requestHash: "b".repeat(64),
    });
    await expect(reusedCommand).rejects.toBeInstanceOf(
      ScheduleIdempotencyConflictError,
    );
    await expect(reusedCommand).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    await expect(
      firstService.place(viewer, input, {
        ...command,
        actorId: "assistant:another-person",
      }),
    ).rejects.toThrow(/match the authenticated person/i);
  });

  it("unassigns and safely undoes only the latest authoritative schedule change", async () => {
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
    const placement = await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    expect(placement.scheduleRevision).toBe(workspace.version!.revision + 1);
    workspace = await service.getWorkspace(viewer);
    const entry = workspace.entries[0]!;
    const unassignment = await service.unassign(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      entryId: entry.id,
    });
    expect(unassignment.scheduleRevision).toBe(placement.scheduleRevision + 1);
    workspace = await service.getWorkspace(viewer);
    expect(workspace.entries).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT status FROM sessions WHERE id = 'schedule-test-one' AND event_id = ?",
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ status: "unscheduled" });

    await expect(
      service.undo(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: unassignment.scheduleRevision,
        undoToken: placement.undo.token,
      }),
    ).rejects.toThrow(/can no longer be undone/i);

    const restored = await service.undo(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: unassignment.scheduleRevision,
      undoToken: unassignment.undo.token,
    });
    expect(restored).toMatchObject({
      entryId: entry.id,
      scheduleRevision: unassignment.scheduleRevision + 1,
      sessionId: "schedule-test-one",
      restoredPlacement: {
        roomId: "main",
        startsAt,
        endsAt: startsAt + 3_600,
      },
    });
    workspace = await service.getWorkspace(viewer);
    expect(workspace.entries).toEqual([
      expect.objectContaining({
        id: entry.id,
        sessionId: "schedule-test-one",
        roomId: "main",
        startsAt,
      }),
    ]);
    expect(
      await env.DB.prepare(
        "SELECT status FROM sessions WHERE id = 'schedule-test-one' AND event_id = ?",
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ status: "scheduled" });
  });

  it("restores a cross-day move from the authoritative snapshot exactly once", async () => {
    const service = new ScheduleService(
      env as unknown as CloudflareEnvironment,
    );
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const originalStartsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt: originalStartsAt,
      endsAt: originalStartsAt + 3_600,
    });
    workspace = await service.getWorkspace(viewer);
    const movedStartsAt = eventLocalTimeEpoch(
      workspace.event.startsAt + 86_400,
      workspace.event.timezone,
      11,
    );
    const move = await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "301a",
      startsAt: movedStartsAt,
      endsAt: movedStartsAt + 5_400,
    });
    workspace = await service.getWorkspace(viewer);
    expect(workspace.entries[0]).toMatchObject({
      roomId: "301a",
      startsAt: movedStartsAt,
      endsAt: movedStartsAt + 5_400,
    });

    const restored = await service.undo(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: move.scheduleRevision,
      undoToken: move.undo.token,
    });
    expect(restored).toMatchObject({
      scheduleRevision: move.scheduleRevision + 1,
      sessionId: "schedule-test-one",
      restoredPlacement: {
        roomId: "main",
        startsAt: originalStartsAt,
        endsAt: originalStartsAt + 3_600,
      },
    });
    workspace = await service.getWorkspace(viewer);
    expect(workspace.entries[0]).toMatchObject({
      roomId: "main",
      startsAt: originalStartsAt,
      endsAt: originalStartsAt + 3_600,
    });
    await expect(
      service.undo(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
        undoToken: move.undo.token,
      }),
    ).rejects.toThrow(/can no longer be undone/i);
  });

  it("creates placeable breaks and enforces exclusive resource overlap policy", async () => {
    const service = new ScheduleService(
      env as unknown as CloudflareEnvironment,
    );
    await env.DB.prepare(
      `UPDATE rooms SET resources_json = '["livestream crew"]'
        WHERE event_id = ? AND id IN ('main', '301a')`,
    )
      .bind(viewer.eventId)
      .run();
    const { sessionId: breakId } = await service.createBreak(viewer, {
      title: "Livestream reset",
      durationMinutes: 30,
      requiredResources: ["livestream crew"],
    });
    await env.DB.prepare(
      `UPDATE sessions SET required_resources_json = '["livestream crew"]'
        WHERE id = 'schedule-test-one' AND event_id = ?`,
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
      service.place(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
        sessionId: breakId,
        roomId: "301a",
        startsAt,
        endsAt: startsAt + 1_800,
      }),
    ).rejects.toMatchObject({
      conflicts: [
        expect.objectContaining({
          type: "required_resource",
          severity: "blocking",
        }),
      ],
    });
  });

  it("updates required resources with authoritative revisions and room validation", async () => {
    const service = new ScheduleService(
      env as unknown as CloudflareEnvironment,
    );
    await env.DB.prepare(
      `UPDATE rooms
          SET resources_json = CASE id
            WHEN 'main' THEN '["livestream crew"]'
            ELSE '[]'
          END
        WHERE event_id = ? AND id IN ('main', '301a')`,
    )
      .bind(viewer.eventId)
      .run();
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const firstSessionRevision = workspace.sessions.find(
      (session) => session.id === "schedule-test-one",
    )!.revision;

    const updated = await service.updateSessionResources(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      sessionRevision: firstSessionRevision,
      requiredResources: ["livestream crew"],
    });
    expect(updated).toMatchObject({
      sessionId: "schedule-test-one",
      revision: firstSessionRevision + 1,
      warnings: [],
    });
    workspace = await service.getWorkspace(viewer);
    expect(
      workspace.sessions.find((session) => session.id === "schedule-test-one"),
    ).toMatchObject({
      revision: firstSessionRevision + 1,
      requiredResources: ["livestream crew"],
    });
    await expect(
      service.updateSessionResources(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
        sessionId: "schedule-test-one",
        sessionRevision: firstSessionRevision,
        requiredResources: [],
      }),
    ).rejects.toBeInstanceOf(ScheduleRevisionConflictError);
    await expect(
      service.updateSessionResources(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
        sessionId: "schedule-test-two",
        sessionRevision: workspace.sessions.find(
          (session) => session.id === "schedule-test-two",
        )!.revision,
        requiredResources: ["unconfigured kit"],
      }),
    ).rejects.toBeInstanceOf(ScheduleConfigurationError);

    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-two",
      roomId: "301a",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    workspace = await service.getWorkspace(viewer);
    const secondSessionRevision = workspace.sessions.find(
      (session) => session.id === "schedule-test-two",
    )!.revision;
    await expect(
      service.updateSessionResources(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
        sessionId: "schedule-test-two",
        sessionRevision: secondSessionRevision,
        requiredResources: ["livestream crew"],
      }),
    ).rejects.toMatchObject({
      conflicts: [
        expect.objectContaining({
          type: "room_resource",
          severity: "blocking",
        }),
      ],
    });
    expect(
      (await service.getWorkspace(viewer)).sessions.find(
        (session) => session.id === "schedule-test-two",
      ),
    ).toMatchObject({
      revision: secondSessionRevision,
      requiredResources: [],
    });
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
      revision: first.revision,
    });
    expect(
      workspace.entries.find((entry) => entry.sessionId === session.id),
    ).toMatchObject({ startsAt, endsAt: startsAt + 45 * 60 });
    expect(
      await env.DB.prepare(
        `SELECT title, description, duration_minutes AS durationMinutes,
                last_operation_id AS lastOperationId
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
    });
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
    const schedule = new ScheduleService(scheduleTestEnv);
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

    const draftSession = draftAfter.sessions.find(
      (session) => session.id === "schedule-test-one",
    )!;
    await schedule.updateSessionContent(viewer, {
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
    });
    const [contentDraft, liveWhileContentDraft] = await Promise.all([
      schedule.getWorkspace(viewer),
      publicProgramme.getPublished("future-of-events-2025"),
    ]);
    expect(
      liveWhileContentDraft?.sessions.find(
        (session) => session.id === "schedule-test-one",
      ),
    ).toEqual(sessionBefore);

    await schedule.publish(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: contentDraft.version!.revision,
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
    expect(
      liveAfterPublication?.sessions.find(
        (session) => session.id === "schedule-test-one",
      ),
    ).toMatchObject({
      title: "Draft-only replacement title",
      description: "Draft-only replacement description.",
    });
  });

  it("publishes a conflict-free version and retains an audit event", async () => {
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
