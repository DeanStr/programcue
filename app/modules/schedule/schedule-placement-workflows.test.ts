import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ContentManagementService } from "~/modules/content/content-management-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";

import {
  ScheduleConfigurationError,
  ScheduleIdempotencyConflictError,
  SchedulePlacementBlockedError,
  SchedulePublicationBlockedError,
  ScheduleRevisionConflictError,
  ScheduleService,
} from "./schedule-service.server";
import {
  approveScheduledTestContent,
  prepareScheduleServiceTest,
  scheduleTestEnv,
  scheduleTestViewer as viewer,
} from "./schedule-service-test-fixture";
import { eventLocalTimeEpoch } from "./schedule-time";

beforeEach(prepareScheduleServiceTest);

describe("schedule placement workflows", () => {
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
    await env.DB.prepare(
      "UPDATE rooms SET capacity = 1 WHERE id = 'main' AND event_id = ?",
    )
      .bind(viewer.eventId)
      .run();
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
    expect(placement).toMatchObject({
      movedExistingEntry: false,
      entry: {
        id: placement.entryId,
        sessionId: "schedule-test-one",
        roomId: "main",
        startsAt,
        endsAt: startsAt + 3_600,
        revision: 1,
      },
      warnings: [
        expect.objectContaining({
          id: expect.any(String),
          type: "capacity",
          severity: "warning",
        }),
      ],
    });
    expect(
      await env.DB.prepare(
        "SELECT id FROM schedule_conflicts WHERE schedule_version_id = ? AND conflict_type = 'capacity'",
      )
        .bind(versionId)
        .first(),
    ).toEqual({ id: placement.warnings[0]!.id });
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
    await approveScheduledTestContent(versionId);

    try {
      workspace = await service.getWorkspace(viewer);
      expect(workspace.conflicts).toEqual([]);
      expect(workspace.publicationConflicts).toEqual([
        expect.objectContaining({
          type: "capacity",
          severity: "blocking",
          entryIds: expect.arrayContaining([expect.any(String)]),
        }),
      ]);
      const publication = service.publish(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
      });
      await expect(publication).rejects.toBeInstanceOf(
        SchedulePublicationBlockedError,
      );
      await expect(publication).rejects.toMatchObject({
        conflicts: workspace.publicationConflicts.map(
          ({ entryIds: _entryIds, ...conflict }) => conflict,
        ),
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
    await env.DB.prepare(
      "UPDATE rooms SET capacity = 1 WHERE id = 'main' AND event_id = ?",
    )
      .bind(viewer.eventId)
      .run();
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
    expect(first.warnings).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        type: "capacity",
        severity: "warning",
      }),
    ]);
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
    expect(move).toMatchObject({
      movedExistingEntry: true,
      entry: {
        sessionId: "schedule-test-one",
        roomId: "301a",
        startsAt: movedStartsAt,
        endsAt: movedStartsAt + 5_400,
        revision: 2,
      },
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
    await env.DB.prepare(
      `UPDATE sessions
          SET description = 'Approved scheduling-requirements test content.'
        WHERE id = 'schedule-test-one' AND event_id = ?`,
    )
      .bind(viewer.eventId)
      .run();
    const versionId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const content = new ContentManagementService(
      env as unknown as CloudflareEnvironment,
    );
    const contentDetail = await content.getSession(viewer, "schedule-test-one");
    await content.changeStatus(viewer, {
      scheduleVersionId: versionId,
      sessionId: "schedule-test-one",
      scheduleRevision: contentDetail.current.scheduleRevision,
      contentRevision: contentDetail.current.contentRevision,
      status: "approved",
      confirmed: true,
    });
    workspace = await service.getWorkspace(viewer);
    const firstSessionRevision = workspace.sessions.find(
      (session) => session.id === "schedule-test-one",
    )!.revision;
    const firstContentRevision = workspace.sessions.find(
      (session) => session.id === "schedule-test-one",
    )!.contentRevision;

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
      contentRevision: firstContentRevision + 1,
      contentStatus: "draft",
      warnings: [],
    });
    workspace = await service.getWorkspace(viewer);
    expect(
      workspace.sessions.find((session) => session.id === "schedule-test-one"),
    ).toMatchObject({
      revision: firstSessionRevision + 1,
      requiredResources: ["livestream crew"],
      contentRevision: firstContentRevision + 1,
      contentStatus: "draft",
    });
    await expect(
      env.DB.prepare(
        `SELECT required_resources_json AS requiredResourcesJson,
                content_status AS contentStatus,
                created_by_person_id AS createdByPersonId
           FROM session_content_revisions
          WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?
          ORDER BY revision_number DESC LIMIT 1`,
      )
        .bind(versionId, viewer.eventId, "schedule-test-one")
        .first(),
    ).resolves.toEqual({
      requiredResourcesJson: '["livestream crew"]',
      contentStatus: "draft",
      createdByPersonId: viewer.personId,
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
});
