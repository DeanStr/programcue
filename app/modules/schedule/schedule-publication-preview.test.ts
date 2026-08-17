import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { buildSchedulePublicationPreview } from "./schedule-publication-preview.server";
import { ScheduleService } from "./schedule-service.server";
import {
  approveScheduledTestContent,
  prepareScheduleServiceTest,
  scheduleTestEnv,
  scheduleTestViewer as viewer,
} from "./schedule-service-test-fixture";
import { eventLocalTimeEpoch } from "./schedule-time";

beforeEach(prepareScheduleServiceTest);

describe("schedule publication preview", () => {
  it("shows the exact draft blockers before publication", async () => {
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
      `UPDATE session_speakers
          SET participation_status = 'pending', participation_confirmed_at = NULL
        WHERE event_id = ? AND session_id = 'schedule-test-one'`,
    )
      .bind(viewer.eventId)
      .run();
    workspace = await service.getWorkspace(viewer);

    const preview = await buildSchedulePublicationPreview(
      scheduleTestEnv,
      viewer,
      workspace,
    );

    expect(preview).toMatchObject({
      publishedVersionNumber: null,
      changes: {
        added: [
          { sessionId: "schedule-test-one", title: "First test session" },
        ],
        removed: [],
        moved: [],
        visibility: [],
      },
      blockers: {
        emptySchedule: false,
        contentVisibility: [],
        contentApproval: [
          { sessionId: "schedule-test-one", title: "First test session" },
        ],
        unconfirmedSpeakers: [
          {
            sessionId: "schedule-test-one",
            title: "First test session",
            speakerName: "Priya Shah",
          },
        ],
      },
    });
  });

  it("compares placements with the current published version", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    const publishedId = await service.createDraft(viewer);
    let workspace = await service.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await service.place(viewer, {
      scheduleVersionId: publishedId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    await approveScheduledTestContent(publishedId);
    workspace = await service.getWorkspace(viewer);
    await service.publish(viewer, {
      scheduleVersionId: publishedId,
      scheduleRevision: workspace.version!.revision,
    });

    const draftId = await service.createDraft(viewer);
    workspace = await service.getWorkspace(viewer);
    const copiedEntry = workspace.entries.find(
      (entry) => entry.sessionId === "schedule-test-one",
    );
    expect(copiedEntry).toBeDefined();
    await service.place(viewer, {
      scheduleVersionId: draftId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-one",
      roomId: "301a",
      startsAt: startsAt + 3_600,
      endsAt: startsAt + 7_200,
    });
    workspace = await service.getWorkspace(viewer);
    await service.place(viewer, {
      scheduleVersionId: draftId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-two",
      roomId: "main",
      startsAt: startsAt + 7_200,
      endsAt: startsAt + 10_800,
    });
    workspace = await service.getWorkspace(viewer);
    const movedSession = workspace.sessions.find(
      (session) => session.id === "schedule-test-one",
    );
    expect(movedSession).toBeDefined();
    await service.updateSessionContent(
      viewer,
      {
        scheduleVersionId: draftId,
        scheduleRevision: workspace.version!.revision,
        sessionId: movedSession!.id,
        sessionRevision: movedSession!.revision,
        idempotencyKey: crypto.randomUUID(),
        title: movedSession!.title,
        description: movedSession!.description,
        format: movedSession!.format,
        durationMinutes: movedSession!.durationMinutes,
        trackId: movedSession!.trackId,
        visibility: "private",
        requiredResources: movedSession!.requiredResources,
      },
      "admin_ui",
    );
    workspace = await service.getWorkspace(viewer);

    const preview = await buildSchedulePublicationPreview(
      scheduleTestEnv,
      viewer,
      workspace,
    );

    expect(preview?.publishedVersionNumber).toBe(1);
    expect(preview?.changes.added).toEqual([
      { sessionId: "schedule-test-two", title: "Second test session" },
    ]);
    expect(preview?.changes.moved).toEqual([
      expect.objectContaining({
        sessionId: "schedule-test-one",
        from: expect.objectContaining({ room: "Main Stage", startsAt }),
        to: expect.objectContaining({
          room: "Room 301A",
          startsAt: startsAt + 3_600,
        }),
      }),
    ]);
    expect(preview?.changes.visibility).toEqual([
      {
        sessionId: "schedule-test-one",
        title: "First test session",
        from: "public",
        to: "private",
      },
    ]);

    const movedEntry = workspace.entries.find(
      (entry) => entry.sessionId === "schedule-test-one",
    );
    expect(movedEntry).toBeDefined();
    await service.unassign(viewer, {
      scheduleVersionId: draftId,
      scheduleRevision: workspace.version!.revision,
      entryId: movedEntry!.id,
    });
    workspace = await service.getWorkspace(viewer);
    const removalPreview = await buildSchedulePublicationPreview(
      scheduleTestEnv,
      viewer,
      workspace,
    );
    expect(removalPreview?.changes.removed).toEqual([
      { sessionId: "schedule-test-one", title: "First test session" },
    ]);
  });

  it("lists every incompatible event-website reference", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    await service.createDraft(viewer);
    const workspace = await service.getWorkspace(viewer);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM event_public_sites WHERE event_id = ?").bind(
        viewer.eventId,
      ),
      env.DB.prepare(
        `INSERT INTO event_public_sites (
           event_id, organisation_id, draft_json, last_updated_by_person_id,
           last_operation_id
         ) VALUES (?, ?, '{}', ?, ?)`,
      ).bind(
        viewer.eventId,
        viewer.organisationId,
        viewer.personId,
        crypto.randomUUID(),
      ),
      env.DB.prepare(
        `INSERT INTO event_public_site_references (
           event_id, organisation_id, kind, record_id, site_revision
         ) VALUES (?, ?, 'session', 'schedule-test-one', 1),
                  (?, ?, 'session', 'schedule-test-two', 1)`,
      ).bind(
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
      ),
    ]);

    const preview = await buildSchedulePublicationPreview(
      scheduleTestEnv,
      viewer,
      workspace,
    );

    expect(preview?.blockers.publicDependencies).toHaveLength(2);
    expect(preview?.blockers.publicDependencies).toEqual([
      expect.stringContaining("First test session"),
      expect.stringContaining("Second test session"),
    ]);
  });
});
