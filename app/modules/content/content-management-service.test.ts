import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import { eventLocalTimeEpoch } from "~/modules/schedule/schedule-time";
import {
  prepareScheduleServiceTest,
  scheduleTestEnv,
  scheduleTestViewer as viewer,
} from "~/modules/schedule/schedule-service-test-fixture";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import { ContentManagementService } from "./content-management-service.server";

beforeEach(prepareScheduleServiceTest);

async function placeSession(
  schedule: ScheduleService,
  versionId: string,
  sessionId: string,
  startsAt: number,
) {
  const workspace = await schedule.getWorkspace(viewer);
  await schedule.place(viewer, {
    scheduleVersionId: versionId,
    scheduleRevision: workspace.version!.revision,
    sessionId,
    roomId: "main",
    startsAt,
    endsAt: startsAt + 3_600,
  });
}

describe("content management", () => {
  it("records attributed immutable revisions, resets approval on edit and restores as a new draft", async () => {
    const schedule = new ScheduleService(scheduleTestEnv);
    const content = new ContentManagementService(scheduleTestEnv);
    const versionId = await schedule.createDraft(viewer);
    let workspace = await schedule.getWorkspace(viewer);
    let session = workspace.sessions.find(
      (candidate) => candidate.id === "schedule-test-one",
    )!;

    await schedule.updateSessionContent(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: session.id,
      sessionRevision: session.revision,
      idempotencyKey: crypto.randomUUID(),
      title: "Approved session title",
      description: "Exact approved public description.",
      format: session.format,
      durationMinutes: session.durationMinutes,
      trackId: session.trackId,
      visibility: "public",
      requiredResources: session.requiredResources,
    });

    let detail = await content.getSession(viewer, session.id);
    const reviewed = await content.changeStatus(viewer, {
      scheduleVersionId: versionId,
      sessionId: session.id,
      scheduleRevision: detail.current.scheduleRevision,
      contentRevision: detail.current.contentRevision,
      status: "in_review",
      confirmed: true,
    });
    const approved = await content.changeStatus(viewer, {
      scheduleVersionId: versionId,
      sessionId: session.id,
      scheduleRevision: reviewed.scheduleRevision,
      contentRevision: reviewed.contentRevision,
      status: "approved",
      confirmed: true,
    });
    expect(approved.status).toBe("approved");

    workspace = await schedule.getWorkspace(viewer);
    session = workspace.sessions.find(
      (candidate) => candidate.id === session.id,
    )!;
    await schedule.updateSessionContent(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: session.id,
      sessionRevision: session.revision,
      idempotencyKey: crypto.randomUUID(),
      title: "Edited after approval",
      description: "This edit requires another approval.",
      format: session.format,
      durationMinutes: session.durationMinutes,
      trackId: session.trackId,
      visibility: "public",
      requiredResources: session.requiredResources,
    });

    detail = await content.getSession(viewer, session.id);
    expect(detail.current).toMatchObject({
      title: "Edited after approval",
      contentStatus: "draft",
    });
    const approvedRevision = detail.revisions.find(
      (revision) => revision.contentStatus === "approved",
    );
    expect(approvedRevision).toMatchObject({
      title: "Approved session title",
      changeKind: "status",
      editorName: expect.any(String),
    });

    await content.restoreRevision(viewer, {
      scheduleVersionId: detail.current.scheduleVersionId,
      sessionId: session.id,
      revisionId: approvedRevision!.id,
      scheduleRevision: detail.current.scheduleRevision,
      contentRevision: detail.current.contentRevision,
      confirmed: true,
    });
    detail = await content.getSession(viewer, session.id);
    expect(detail.current).toMatchObject({
      title: "Approved session title",
      description: "Exact approved public description.",
      contentStatus: "draft",
    });
    expect(detail.revisions[0]).toMatchObject({
      changeKind: "restore",
      restoredFromRevisionId: approvedRevision!.id,
      contentStatus: "draft",
    });
  });

  it.each(["private", "hidden"] as const)(
    "approves %s session content without a public description",
    async (visibility) => {
      const schedule = new ScheduleService(scheduleTestEnv);
      const content = new ContentManagementService(scheduleTestEnv);
      const versionId = await schedule.createDraft(viewer);
      const workspace = await schedule.getWorkspace(viewer);
      const session = workspace.sessions.find(
        (candidate) => candidate.id === "schedule-test-one",
      )!;

      await schedule.updateSessionContent(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
        sessionId: session.id,
        sessionRevision: session.revision,
        idempotencyKey: crypto.randomUUID(),
        title: session.title,
        description: "",
        format: session.format,
        durationMinutes: session.durationMinutes,
        trackId: session.trackId,
        visibility,
        requiredResources: session.requiredResources,
      });

      const detail = await content.getSession(viewer, session.id);
      await expect(
        content.changeStatus(viewer, {
          scheduleVersionId: versionId,
          sessionId: session.id,
          scheduleRevision: detail.current.scheduleRevision,
          contentRevision: detail.current.contentRevision,
          status: "approved",
          confirmed: true,
        }),
      ).resolves.toMatchObject({ status: "approved" });
    },
  );

  it("keeps every retained content revision reachable through bounded pages", async () => {
    const schedule = new ScheduleService(scheduleTestEnv);
    const content = new ContentManagementService(scheduleTestEnv);
    const versionId = await schedule.createDraft(viewer);
    const statements: D1PreparedStatement[] = [];
    for (let revisionNumber = 2; revisionNumber <= 56; revisionNumber += 1) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO session_content_revisions (
             id, event_id, schedule_version_id, session_id, revision_number,
             title, slug, description, track_id, format, duration_minutes,
             required_resources_json, visibility, content_status, change_kind,
             created_by_person_id, created_at
           )
           SELECT ?, content.event_id, content.schedule_version_id,
                  content.session_id, ?, ?, content.slug, content.description,
                  content.track_id, content.format, content.duration_minutes,
                  content.required_resources_json, content.visibility,
                  content.content_status, 'edit', ?, unixepoch()
             FROM schedule_session_contents content
            WHERE content.schedule_version_id = ? AND content.event_id = ?
              AND content.session_id = 'schedule-test-one'`,
        ).bind(
          `history-test-${revisionNumber}`,
          revisionNumber,
          `History revision ${revisionNumber}`,
          viewer.personId,
          versionId,
          viewer.eventId,
        ),
      );
    }
    await env.DB.batch(statements);

    const firstPage = await content.getSession(viewer, "schedule-test-one");
    expect(firstPage.revisions).toHaveLength(50);
    expect(firstPage.revisions[0]?.revisionNumber).toBe(56);
    expect(firstPage.nextHistoryCursor).toBe(
      `${firstPage.revisions.at(-1)?.scheduleVersionNumber}:7`,
    );

    const secondPage = await content.getSession(
      viewer,
      "schedule-test-one",
      firstPage.nextHistoryCursor,
    );
    expect(
      secondPage.revisions.map((revision) => revision.revisionNumber),
    ).toEqual([6, 5, 4, 3, 2, 1]);
    expect(secondPage.nextHistoryCursor).toBeNull();
    await expect(
      content.getSession(viewer, "schedule-test-one", "not-a-cursor"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("blocks partial publication and exposes the complete approved programme", async () => {
    const schedule = new ScheduleService(scheduleTestEnv);
    const content = new ContentManagementService(scheduleTestEnv);
    const versionId = await schedule.createDraft(viewer);
    let workspace = await schedule.getWorkspace(viewer);
    const start = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await placeSession(schedule, versionId, "schedule-test-one", start);
    await placeSession(schedule, versionId, "schedule-test-two", start + 7_200);

    workspace = await schedule.getWorkspace(viewer);
    const approvedSession = workspace.sessions.find(
      (candidate) => candidate.id === "schedule-test-one",
    )!;
    await schedule.updateSessionContent(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: approvedSession.id,
      sessionRevision: approvedSession.revision,
      idempotencyKey: crypto.randomUUID(),
      title: "Approved public session",
      description: "This approved session may be published.",
      format: approvedSession.format,
      durationMinutes: approvedSession.durationMinutes,
      trackId: approvedSession.trackId,
      visibility: "public",
      requiredResources: approvedSession.requiredResources,
    });
    let detail = await content.getSession(viewer, approvedSession.id);
    await content.changeStatus(viewer, {
      scheduleVersionId: versionId,
      sessionId: approvedSession.id,
      scheduleRevision: detail.current.scheduleRevision,
      contentRevision: detail.current.contentRevision,
      status: "approved",
      confirmed: true,
    });
    workspace = await schedule.getWorkspace(viewer);
    await expect(
      schedule.publish(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
      }),
    ).rejects.toThrow(/approve content for Second test session/i);

    const secondSession = workspace.sessions.find(
      (candidate) => candidate.id === "schedule-test-two",
    )!;
    await schedule.updateSessionContent(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: secondSession.id,
      sessionRevision: secondSession.revision,
      idempotencyKey: crypto.randomUUID(),
      title: secondSession.title,
      description:
        "The second scheduled session is also ready for publication.",
      format: secondSession.format,
      durationMinutes: secondSession.durationMinutes,
      trackId: secondSession.trackId,
      visibility: "public",
      requiredResources: secondSession.requiredResources,
    });
    detail = await content.getSession(viewer, secondSession.id);
    await content.changeStatus(viewer, {
      scheduleVersionId: versionId,
      sessionId: secondSession.id,
      scheduleRevision: detail.current.scheduleRevision,
      contentRevision: detail.current.contentRevision,
      status: "approved",
      confirmed: true,
    });
    workspace = await schedule.getWorkspace(viewer);
    await schedule.publish(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
    });

    const programme = await new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    ).getPublished("future-of-events-2025");
    expect(programme?.sessions.map((session) => session.id)).toEqual([
      approvedSession.id,
      secondSession.id,
    ]);
    expect(
      programme?.speakers.flatMap((speaker) => speaker.sessionIds),
    ).toContain(secondSession.id);
  });

  it("exports only the exact current released file versions after confirmation", async () => {
    const content = new ContentManagementService(scheduleTestEnv);
    const assetId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const objectKey = `private/content-tests/${versionId}`;
    const bytes = new TextEncoder().encode("conference content");
    const object = await env.FILES.put(objectKey, bytes);
    if (!object) throw new Error("The test R2 object was not created.");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, 'session', 'schedule-test-one', 'slides',
                   'active', unixepoch(), unixepoch())`,
      ).bind(assetId, viewer.eventId, viewer.personId),
      env.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status,
           scan_status, released_at, created_by_person_id, created_at
         ) VALUES (?, ?, ?, 1, ?, 'slides.pdf', 'application/pdf',
                   'application/pdf', ?, ?, 'uploaded', 'valid', 'clean',
                   unixepoch(), ?, unixepoch())`,
      ).bind(
        versionId,
        viewer.eventId,
        assetId,
        objectKey,
        bytes.byteLength,
        object.httpEtag,
        viewer.personId,
      ),
      env.DB.prepare(
        `UPDATE file_assets SET current_version_id = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(versionId, assetId, viewer.eventId),
    ]);

    const dashboard = await content.getDashboard(viewer);
    expect(dashboard.files.find((asset) => asset.id === assetId)).toMatchObject(
      {
        currentVersionId: versionId,
        versions: [expect.objectContaining({ id: versionId, current: true })],
      },
    );
    const preview = await content.previewZip(viewer, {
      assetIds: [assetId],
      groupBy: "session",
    });
    const response = await content.downloadZip(viewer, {
      manifest: preview.manifest,
      groupBy: preview.groupBy,
      confirmed: true,
    });
    const zip = new Uint8Array(await response.arrayBuffer());
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(new TextDecoder().decode(zip)).toContain(
      "Approved public session/slides.pdf",
    );
    expect(new TextDecoder().decode(zip)).toContain("conference content");
  });

  it("groups submission-owned files under their resulting session", async () => {
    const content = new ContentManagementService(scheduleTestEnv);
    const submissionId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const objectKey = `private/content-tests/${versionId}`;
    const bytes = new TextEncoder().encode("accepted submission attachment");
    const object = await env.FILES.put(objectKey, bytes);
    if (!object) throw new Error("The test R2 object was not created.");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, submitter_person_id, public_reference, title, status,
           submitted_snapshot_json, submitted_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'Accepted proposal', 'accepted', '{}',
                   unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        submissionId,
        viewer.eventId,
        viewer.personId,
        `CONTENT-${submissionId}`,
      ),
      env.DB.prepare(
        `UPDATE sessions SET source_submission_id = ?
          WHERE id = 'schedule-test-one' AND event_id = ?`,
      ).bind(submissionId, viewer.eventId),
      env.DB.prepare(
        `INSERT INTO file_assets (
         id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, 'submission', ?, 'supporting_document',
                   'active', unixepoch(), unixepoch())`,
      ).bind(assetId, viewer.eventId, viewer.personId, submissionId),
      env.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status,
           scan_status, released_at, created_by_person_id, created_at
         ) VALUES (?, ?, ?, 1, ?, 'proposal.pdf', 'application/pdf',
                   'application/pdf', ?, ?, 'uploaded', 'valid', 'clean',
                   unixepoch(), ?, unixepoch())`,
      ).bind(
        versionId,
        viewer.eventId,
        assetId,
        objectKey,
        bytes.byteLength,
        object.httpEtag,
        viewer.personId,
      ),
      env.DB.prepare(
        `UPDATE file_assets SET current_version_id = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(versionId, assetId, viewer.eventId),
    ]);

    const dashboard = await content.getDashboard(viewer);
    expect(dashboard.files.find((asset) => asset.id === assetId)).toMatchObject(
      {
        sessionName: "Approved public session",
      },
    );
    const preview = await content.previewZip(viewer, {
      assetIds: [assetId],
      groupBy: "session",
    });
    expect(preview.entries).toEqual([
      expect.objectContaining({ sessionName: "Approved public session" }),
    ]);
    const response = await content.downloadZip(viewer, {
      manifest: preview.manifest,
      groupBy: preview.groupBy,
      confirmed: true,
    });
    expect(new TextDecoder().decode(await response.arrayBuffer())).toContain(
      "Approved public session/proposal.pdf",
    );
  });
});
