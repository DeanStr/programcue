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

beforeEach(async () => {
  await prepareScheduleServiceTest();
  await env.DB.prepare(
    `UPDATE sessions
        SET title = CASE id
              WHEN 'schedule-test-one' THEN 'First test session'
              ELSE 'Second test session'
            END,
            description = NULL,
            format = CASE id
              WHEN 'schedule-test-one' THEN 'presentation'
              ELSE 'panel'
            END,
            duration_minutes = 60,
            track_id = 'schedule-test-track',
            visibility = 'public'
      WHERE event_id = ?
        AND id IN ('schedule-test-one', 'schedule-test-two')`,
  )
    .bind(viewer.eventId)
    .run();
});

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
            participationStatus: "pending",
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

  it("compares snapshotted public content separately from placement", async () => {
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
    await env.DB.prepare(
      `INSERT OR IGNORE INTO tracks (id, event_id, name, slug, position)
       VALUES ('schedule-test-content-track', ?, 'Content Track', 'content-track', 20)`,
    )
      .bind(viewer.eventId)
      .run();
    const session = workspace.sessions.find(
      (candidate) => candidate.id === "schedule-test-one",
    );
    expect(session).toBeDefined();
    await service.updateSessionContent(
      viewer,
      {
        scheduleVersionId: draftId,
        scheduleRevision: workspace.version!.revision,
        sessionId: session!.id,
        sessionRevision: session!.revision,
        idempotencyKey: crypto.randomUUID(),
        title: "Revised first session",
        description: "A public abstract that will become live.",
        format: "panel",
        durationMinutes: session!.durationMinutes,
        trackId: "schedule-test-content-track",
        visibility: session!.visibility,
        requiredResources: session!.requiredResources,
      },
      "admin_ui",
    );
    workspace = await service.getWorkspace(viewer);

    const preview = await buildSchedulePublicationPreview(
      scheduleTestEnv,
      viewer,
      workspace,
    );

    expect(preview?.changes.added).toEqual([]);
    expect(preview?.changes.removed).toEqual([]);
    expect(preview?.changes.moved).toEqual([]);
    expect(preview?.changes.visibility).toEqual([]);
    expect(preview?.changes.content).toEqual([
      {
        sessionId: "schedule-test-one",
        title: "Revised first session",
        fields: [
          {
            field: "title",
            before: "First test session",
            after: "Revised first session",
          },
          {
            field: "description",
            before: "—",
            after: "A public abstract that will become live.",
          },
          {
            field: "track",
            before: "Operations",
            after: "Content Track",
          },
          {
            field: "format",
            before: "Presentation",
            after: "Panel",
          },
        ],
      },
    ]);
  });

  it("treats a private track as absent from the public programme", async () => {
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
    await env.DB.prepare(
      `INSERT OR IGNORE INTO tracks (id, event_id, name, slug, position, is_public)
       VALUES ('schedule-test-private-track', ?, 'Internal Track', 'internal-track', 30, 0)`,
    )
      .bind(viewer.eventId)
      .run();
    const session = workspace.sessions.find(
      (candidate) => candidate.id === "schedule-test-one",
    );
    expect(session).toBeDefined();
    await service.updateSessionContent(
      viewer,
      {
        scheduleVersionId: draftId,
        scheduleRevision: workspace.version!.revision,
        sessionId: session!.id,
        sessionRevision: session!.revision,
        idempotencyKey: crypto.randomUUID(),
        title: session!.title,
        description: session!.description,
        format: session!.format,
        durationMinutes: session!.durationMinutes,
        trackId: "schedule-test-private-track",
        visibility: session!.visibility,
        requiredResources: session!.requiredResources,
      },
      "admin_ui",
    );
    workspace = await service.getWorkspace(viewer);

    const preview = await buildSchedulePublicationPreview(
      scheduleTestEnv,
      viewer,
      workspace,
    );
    expect(
      preview?.changes.content[0]?.fields.find(
        (field) => field.field === "track",
      ),
    ).toEqual({
      field: "track",
      before: "Operations",
      after: "No track",
    });
  });

  it("lists only a private session title edit as notification content", async () => {
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
    const session = workspace.sessions.find(
      (candidate) => candidate.id === "schedule-test-one",
    );
    expect(session).toBeDefined();
    await service.updateSessionContent(
      viewer,
      {
        scheduleVersionId: draftId,
        scheduleRevision: workspace.version!.revision,
        sessionId: session!.id,
        sessionRevision: session!.revision,
        idempotencyKey: crypto.randomUUID(),
        title: "Internal only title",
        description: session!.description,
        format: session!.format,
        durationMinutes: session!.durationMinutes,
        trackId: session!.trackId,
        visibility: "private",
        requiredResources: session!.requiredResources,
      },
      "admin_ui",
    );
    workspace = await service.getWorkspace(viewer);

    const preview = await buildSchedulePublicationPreview(
      scheduleTestEnv,
      viewer,
      workspace,
    );
    expect(preview?.changes.content).toEqual([
      {
        sessionId: "schedule-test-one",
        title: "Internal only title",
        fields: [
          {
            field: "title",
            before: "First test session",
            after: "Internal only title",
          },
        ],
      },
    ]);
    expect(preview?.changes.visibility).toEqual([
      {
        sessionId: "schedule-test-one",
        title: "Internal only title",
        from: "public",
        to: "private",
      },
    ]);
    expect(preview?.notifications.materialSessionCount).toBe(1);
  });

  it("excerpts long public description changes", async () => {
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
    const session = workspace.sessions.find(
      (candidate) => candidate.id === "schedule-test-one",
    );
    expect(session).toBeDefined();
    const longDescription = `${"A detailed public abstract. ".repeat(80)}End.`;
    await service.updateSessionContent(
      viewer,
      {
        scheduleVersionId: draftId,
        scheduleRevision: workspace.version!.revision,
        sessionId: session!.id,
        sessionRevision: session!.revision,
        idempotencyKey: crypto.randomUUID(),
        title: session!.title,
        description: longDescription,
        format: session!.format,
        durationMinutes: session!.durationMinutes,
        trackId: session!.trackId,
        visibility: session!.visibility,
        requiredResources: session!.requiredResources,
      },
      "admin_ui",
    );
    workspace = await service.getWorkspace(viewer);

    const preview = await buildSchedulePublicationPreview(
      scheduleTestEnv,
      viewer,
      workspace,
    );
    const descriptionChange = preview?.changes.content[0]?.fields.find(
      (field) => field.field === "description",
    );
    expect(descriptionChange).toMatchObject({
      before: "—",
      excerpted: true,
    });
    expect(descriptionChange?.after.endsWith("…")).toBe(true);
    expect(descriptionChange?.after.length).toBeLessThan(
      longDescription.length,
    );
    expect(descriptionChange?.after).not.toContain("End.");
  });

  it("does not treat a literal None description as empty", async () => {
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
    const session = workspace.sessions.find(
      (candidate) => candidate.id === "schedule-test-one",
    );
    expect(session).toBeDefined();
    await service.updateSessionContent(
      viewer,
      {
        scheduleVersionId: draftId,
        scheduleRevision: workspace.version!.revision,
        sessionId: session!.id,
        sessionRevision: session!.revision,
        idempotencyKey: crypto.randomUUID(),
        title: session!.title,
        description: "No description",
        format: session!.format,
        durationMinutes: session!.durationMinutes,
        trackId: session!.trackId,
        visibility: session!.visibility,
        requiredResources: session!.requiredResources,
      },
      "admin_ui",
    );
    workspace = await service.getWorkspace(viewer);

    const preview = await buildSchedulePublicationPreview(
      scheduleTestEnv,
      viewer,
      workspace,
    );
    expect(
      preview?.changes.content[0]?.fields.find(
        (field) => field.field === "description",
      ),
    ).toEqual({
      field: "description",
      before: "—",
      after: "No description",
    });
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
