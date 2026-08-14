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
import {
  assertContentApprovalProvenance,
  ContentManagementService,
} from "./content-management-service.server";

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
  it("attributes a speaker task file to its one linked session", async () => {
    const content = new ContentManagementService(scheduleTestEnv);
    const personId = "content-session-speaker";
    const sessionId = "content-session-attribution";
    const taskId = "content-session-task";
    const assetId = "content-session-asset";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO people (id, email, display_name, created_at, updated_at)
         VALUES (?, 'content-session-speaker@example.com', 'Session Speaker',
                 unixepoch(), unixepoch())`,
      ).bind(personId),
      env.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, track_id, title, slug, format, duration_minutes,
           status, visibility, revision, created_at, updated_at
         ) VALUES (?, ?, 'schedule-test-track', 'Session-linked presentation',
                   'session-linked-presentation', 'presentation', 45,
                   'unscheduled', 'public', 1, unixepoch(), unixepoch())`,
      ).bind(sessionId, viewer.eventId),
      env.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, participation_status,
           participation_confirmed_at, visibility
         ) VALUES (?, ?, ?, 0, 'confirmed', unixepoch(), 'public')`,
      ).bind(sessionId, viewer.eventId, personId),
      env.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, owner_person_id, title,
           task_type, impact, status, readiness_state, readiness_percent,
           revision, created_at, updated_at
         ) VALUES (?, ?, 'speaker', ?, ?, 'Upload Session Presentation',
                   'file_upload', 'high', 'submitted', 'on_track', 100, 1,
                   unixepoch(), unixepoch())`,
      ).bind(taskId, viewer.eventId, personId, personId),
      env.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, 'task', ?, 'task_evidence', 'active',
                   unixepoch(), unixepoch())`,
      ).bind(assetId, viewer.eventId, personId, taskId),
    ]);

    const dashboard = await content.getDashboard(viewer);
    expect(dashboard.files.find((asset) => asset.id === assetId)).toMatchObject(
      {
        speakerName: "Session Speaker",
        sessionName: "Session-linked presentation",
      },
    );

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, track_id, title, slug, format, duration_minutes,
           status, visibility, revision, created_at, updated_at
         ) VALUES ('content-second-session', ?, 'schedule-test-track',
                   'Another linked session', 'another-linked-session',
                   'presentation', 45, 'unscheduled', 'public', 1,
                   unixepoch(), unixepoch())`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, participation_status,
           participation_confirmed_at, visibility
         ) VALUES ('content-second-session', ?, ?, 0, 'confirmed',
                   unixepoch(), 'public')`,
      ).bind(viewer.eventId, personId),
    ]);
    const ambiguousDashboard = await content.getDashboard(viewer);
    expect(
      ambiguousDashboard.files.find((asset) => asset.id === assetId),
    ).toMatchObject({ sessionName: "Unassigned" });
  });

  it("fails fast when approval provenance is incomplete", () => {
    const invalidStates = [
      {
        sessionId: "missing-approver",
        contentStatus: "approved" as const,
        approvedByPersonId: null,
        approvedByName: null,
        approvedAt: 100,
        approvalSource: "editorial" as const,
      },
      {
        sessionId: "missing-source",
        contentStatus: "approved" as const,
        approvedByPersonId: "reviewer",
        approvedByName: "Editorial reviewer",
        approvedAt: 100,
        approvalSource: null,
      },
      {
        sessionId: "stale-audit-state",
        contentStatus: "draft" as const,
        approvedByPersonId: null,
        approvedByName: null,
        approvedAt: 100,
        approvalSource: null,
      },
    ];

    for (const state of invalidStates) {
      expect(() => assertContentApprovalProvenance(state)).toThrow(
        `Session ${state.sessionId} has inconsistent approval provenance.`,
      );
    }
  });

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
    expect(
      (await content.getSession(viewer, session.id)).current,
    ).toMatchObject({
      approvedByName: expect.any(String),
      approvalSource: "editorial",
    });

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
      approvalSource: null,
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

  it("keeps editorial status advisory while publishing the complete public snapshot", async () => {
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
    const detail = await content.getSession(viewer, approvedSession.id);
    await content.changeStatus(viewer, {
      scheduleVersionId: versionId,
      sessionId: approvedSession.id,
      scheduleRevision: detail.current.scheduleRevision,
      contentRevision: detail.current.contentRevision,
      status: "approved",
      confirmed: true,
    });
    const secondSession = workspace.sessions.find(
      (candidate) => candidate.id === "schedule-test-two",
    )!;
    workspace = await schedule.getWorkspace(viewer);
    expect(
      workspace.sessions.find((session) => session.id === secondSession.id)
        ?.contentStatus,
    ).toBe("draft");
    await schedule.publish(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
    });

    const programme = await new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    ).getPublished("future-of-events-2027");
    expect(programme?.sessions.map((session) => session.id)).toEqual([
      approvedSession.id,
      secondSession.id,
    ]);
    expect(
      programme?.speakers.flatMap((speaker) => speaker.sessionIds),
    ).toContain(secondSession.id);
    await expect(
      env.DB.prepare(
        `SELECT content_status AS contentStatus
           FROM schedule_session_contents
          WHERE schedule_version_id = ? AND session_id = ?`,
      )
        .bind(versionId, secondSession.id)
        .first(),
    ).resolves.toEqual({ contentStatus: "draft" });
  });

  it("exports only the exact current released file versions after confirmation", async () => {
    const content = new ContentManagementService(scheduleTestEnv);
    const assetId = "contentzipassetaaaaaaaa";
    const versionId = "content-zip-version-a";
    const naturalCollisionAssetId = "contentzipnaturalcccccc";
    const naturalCollisionVersionId = "content-zip-version-natural";
    const duplicateAssetId = "contentzipzzzzbbbbbbbb";
    const duplicateVersionId = "content-zip-version-b";
    const objectKey = `private/content-tests/${versionId}`;
    const naturalCollisionObjectKey = `private/content-tests/${naturalCollisionVersionId}`;
    const duplicateObjectKey = `private/content-tests/${duplicateVersionId}`;
    const bytes = new TextEncoder().encode("conference content");
    const naturalCollisionBytes = new TextEncoder().encode(
      "naturally suffixed content",
    );
    const duplicateBytes = new TextEncoder().encode("updated slide content");
    const object = await env.FILES.put(objectKey, bytes);
    const naturalCollisionObject = await env.FILES.put(
      naturalCollisionObjectKey,
      naturalCollisionBytes,
    );
    const duplicateObject = await env.FILES.put(
      duplicateObjectKey,
      duplicateBytes,
    );
    if (!object) throw new Error("The test R2 object was not created.");
    if (!naturalCollisionObject)
      throw new Error("The natural-collision R2 object was not created.");
    if (!duplicateObject)
      throw new Error("The duplicate test R2 object was not created.");
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
      env.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, 'session', 'schedule-test-one',
                   'supporting_document', 'active', unixepoch(), unixepoch())`,
      ).bind(naturalCollisionAssetId, viewer.eventId, viewer.personId),
      env.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status,
           scan_status, released_at, created_by_person_id, created_at
         ) VALUES (?, ?, ?, 1, ?, 'slides-bbbbbbbb.pdf', 'application/pdf',
                   'application/pdf', ?, ?, 'uploaded', 'valid', 'clean',
                   unixepoch(), ?, unixepoch())`,
      ).bind(
        naturalCollisionVersionId,
        viewer.eventId,
        naturalCollisionAssetId,
        naturalCollisionObjectKey,
        naturalCollisionBytes.byteLength,
        naturalCollisionObject.httpEtag,
        viewer.personId,
      ),
      env.DB.prepare(
        `UPDATE file_assets SET current_version_id = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(
        naturalCollisionVersionId,
        naturalCollisionAssetId,
        viewer.eventId,
      ),
      env.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, 'session', 'schedule-test-one',
                   'other', 'active', unixepoch(), unixepoch())`,
      ).bind(duplicateAssetId, viewer.eventId, viewer.personId),
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
        duplicateVersionId,
        viewer.eventId,
        duplicateAssetId,
        duplicateObjectKey,
        duplicateBytes.byteLength,
        duplicateObject.httpEtag,
        viewer.personId,
      ),
      env.DB.prepare(
        `UPDATE file_assets SET current_version_id = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(duplicateVersionId, duplicateAssetId, viewer.eventId),
    ]);

    const dashboard = await content.getDashboard(viewer);
    expect(dashboard.files.find((asset) => asset.id === assetId)).toMatchObject(
      {
        currentVersionId: versionId,
        versions: [expect.objectContaining({ id: versionId, current: true })],
      },
    );
    const preview = await content.previewZip(viewer, {
      assetIds: [assetId, naturalCollisionAssetId, duplicateAssetId],
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
    expect(new TextDecoder().decode(zip)).toContain(
      "Approved public session/slides-bbbbbbbb.pdf",
    );
    expect(new TextDecoder().decode(zip)).toContain(
      "Approved public session/slides-bbbbbbbb-2.pdf",
    );
    expect(new TextDecoder().decode(zip)).toContain("conference content");
  });

  it("downloads retained clean file versions by exact authorised identity", async () => {
    const content = new ContentManagementService(scheduleTestEnv);
    const assetId = crypto.randomUUID();
    const firstVersionId = crypto.randomUUID();
    const secondVersionId = crypto.randomUUID();
    const firstKey = `private/content-tests/${firstVersionId}`;
    const secondKey = `private/content-tests/${secondVersionId}`;
    const firstBytes = new TextEncoder().encode("version one");
    const secondBytes = new TextEncoder().encode("version two");
    const [firstObject, secondObject] = await Promise.all([
      env.FILES.put(firstKey, firstBytes),
      env.FILES.put(secondKey, secondBytes),
    ]);
    if (!firstObject || !secondObject) {
      throw new Error("The retained-version test objects were not created.");
    }
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           current_version_id, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'session', ?, 'slides',
                   ?, 'active', unixepoch(), unixepoch())`,
      ).bind(
        assetId,
        viewer.eventId,
        viewer.personId,
        `content-version-target-${assetId}`,
        secondVersionId,
      ),
      env.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status,
           scan_status, released_at, replaced_at, created_by_person_id, created_at
         ) VALUES (?, ?, ?, 1, ?, 'slides-v1.pdf', 'application/pdf',
                   'application/pdf', ?, ?, 'uploaded', 'valid', 'clean',
                   unixepoch(), unixepoch(), ?, unixepoch())`,
      ).bind(
        firstVersionId,
        viewer.eventId,
        assetId,
        firstKey,
        firstBytes.byteLength,
        firstObject.httpEtag,
        viewer.personId,
      ),
      env.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status,
           scan_status, released_at, created_by_person_id, created_at
         ) VALUES (?, ?, ?, 2, ?, 'slides-v2.pdf', 'application/pdf',
                   'application/pdf', ?, ?, 'uploaded', 'valid', 'clean',
                   unixepoch(), ?, unixepoch())`,
      ).bind(
        secondVersionId,
        viewer.eventId,
        assetId,
        secondKey,
        secondBytes.byteLength,
        secondObject.httpEtag,
        viewer.personId,
      ),
    ]);

    const firstDownload = await content.downloadFileVersion(
      viewer,
      assetId,
      firstVersionId,
    );
    const currentDownload = await content.downloadFileVersion(
      viewer,
      assetId,
      secondVersionId,
    );
    expect(new TextDecoder().decode(await firstDownload.arrayBuffer())).toBe(
      "version one",
    );
    expect(new TextDecoder().decode(await currentDownload.arrayBuffer())).toBe(
      "version two",
    );
    expect(firstDownload.headers.get("content-disposition")).toContain(
      "slides-v1.pdf",
    );
    await expect(
      content.downloadFileVersion(
        { ...viewer, role: "speaker" },
        assetId,
        firstVersionId,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("uses upload time in the file dashboard and rejects released files without detected MIME", async () => {
    const content = new ContentManagementService(scheduleTestEnv);
    const assetId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const objectKey = `private/content-tests/${versionId}`;
    const bytes = new TextEncoder().encode("released content");
    const object = await env.FILES.put(objectKey, bytes);
    if (!object) throw new Error("The test R2 object was not created.");
    const createdAt = 1_700_000_000;
    const uploadedAt = 1_700_000_100;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           current_version_id, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'session', ?, 'slides', ?, 'active', ?, ?)`,
      ).bind(
        assetId,
        viewer.eventId,
        viewer.personId,
        `content-mime-target-${assetId}`,
        versionId,
        createdAt,
        uploadedAt,
      ),
      env.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status,
           scan_status, released_at, created_by_person_id, created_at,
           uploaded_at
         ) VALUES (?, ?, ?, 1, ?, 'released.pdf', 'application/pdf', NULL,
                   ?, ?, 'uploaded', 'valid', 'clean', ?, ?, ?, ?)`,
      ).bind(
        versionId,
        viewer.eventId,
        assetId,
        objectKey,
        bytes.byteLength,
        object.httpEtag,
        uploadedAt,
        viewer.personId,
        createdAt,
        uploadedAt,
      ),
    ]);

    const dashboardVersion = (await content.getDashboard(viewer)).files
      .find((asset) => asset.id === assetId)
      ?.versions.at(0);
    expect(dashboardVersion).toMatchObject({
      id: versionId,
      uploadedAt,
    });
    expect(
      (await content.getFileVersions(viewer, assetId)).versions[0],
    ).toMatchObject({ id: versionId, uploadedAt });
    await expect(content.downloadCurrentFile(viewer, assetId)).rejects.toThrow(
      /missing its detected content type/i,
    );
    await expect(
      content.downloadFileVersion(viewer, assetId, versionId),
    ).rejects.toThrow(/missing its detected content type/i);

    await env.DB.prepare(
      "UPDATE file_versions SET detected_content_type = 'application/pdf' WHERE id = ? AND event_id = ?",
    )
      .bind(versionId, viewer.eventId)
      .run();
    expect(
      (await content.downloadCurrentFile(viewer, assetId)).headers.get(
        "content-type",
      ),
    ).toBe("application/pdf");
    expect(
      (
        await content.downloadFileVersion(viewer, assetId, versionId)
      ).headers.get("content-type"),
    ).toBe("application/pdf");
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

  it("bounds the file library and loads retained versions in separate pages", async () => {
    const content = new ContentManagementService(scheduleTestEnv);
    const initialFileTotal = (await content.getDashboard(viewer))
      .filesPagination.total;
    await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         VALUES (1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 55
       )
       INSERT INTO file_assets (
         id, event_id, owner_person_id, target_type, target_id, asset_kind,
         status, created_at, updated_at
       )
       SELECT printf('content-page-asset-%02d', value), ?, ?, 'task',
              printf('content-page-task-%02d', value), 'other', 'active',
              1700000000 + value, 1700000000 + value
         FROM sequence`,
    )
      .bind(viewer.eventId, viewer.personId)
      .run();
    await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         VALUES (1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 52
       )
       INSERT INTO file_versions (
         id, event_id, asset_id, version_number, object_key,
         original_filename, declared_content_type, size_bytes,
         upload_status, signature_status, scan_status, created_at
       )
       SELECT printf('content-page-version-%02d', value), ?,
              'content-page-asset-55', value,
              printf('content-page/object-%02d', value),
              printf('slides-%02d.pdf', value), 'application/pdf', value,
              'requested', 'pending', 'pending', 1700000000 + value
         FROM sequence`,
    )
      .bind(viewer.eventId)
      .run();
    await env.DB.prepare(
      `UPDATE file_assets
          SET current_version_id = 'content-page-version-52'
        WHERE id = 'content-page-asset-55' AND event_id = ?`,
    )
      .bind(viewer.eventId)
      .run();

    const firstPage = await content.getDashboard(viewer, 1);
    expect(firstPage.files).toHaveLength(50);
    expect(firstPage.filesPagination).toEqual({
      page: 1,
      pageSize: 50,
      total: initialFileTotal + 55,
      hasPrevious: false,
      hasNext: true,
    });
    expect(
      firstPage.files.find((asset) => asset.id === "content-page-asset-55"),
    ).toMatchObject({
      id: "content-page-asset-55",
      versionCount: 52,
      versions: [expect.objectContaining({ id: "content-page-version-52" })],
    });

    const secondPage = await content.getDashboard(viewer, 2);
    expect(secondPage.files).toHaveLength(initialFileTotal + 5);
    expect(secondPage.filesPagination).toMatchObject({
      page: 2,
      hasPrevious: true,
      hasNext: false,
    });

    const firstVersions = await content.getFileVersions(
      viewer,
      "content-page-asset-55",
      1,
    );
    expect(firstVersions.versions).toHaveLength(50);
    expect(firstVersions).toMatchObject({ total: 52, hasNext: true });
    expect(firstVersions.versions[0]).toMatchObject({
      id: "content-page-version-52",
      latest: true,
    });
    const secondVersions = await content.getFileVersions(
      viewer,
      "content-page-asset-55",
      2,
    );
    expect(secondVersions.versions).toHaveLength(2);
    expect(secondVersions).toMatchObject({ hasPrevious: true, hasNext: false });
    expect(secondVersions.versions.every((version) => !version.latest)).toBe(
      true,
    );
  });

  it("rejects out-of-range file pages even when the bounded collection is empty", async () => {
    const content = new ContentManagementService(scheduleTestEnv);
    await env.DB.prepare("DELETE FROM file_assets WHERE event_id = ?")
      .bind(viewer.eventId)
      .run();

    await expect(content.getDashboard(viewer, 2)).rejects.toMatchObject({
      status: 404,
    });

    await env.DB.prepare(
      `INSERT INTO file_assets (
         id, event_id, owner_person_id, target_type, target_id, asset_kind,
         status, created_at, updated_at
       ) VALUES ('content-empty-version-asset', ?, ?, 'task',
                 'content-empty-version-task', 'other', 'active',
                 unixepoch(), unixepoch())`,
    )
      .bind(viewer.eventId, viewer.personId)
      .run();
    await expect(
      content.getFileVersions(viewer, "content-empty-version-asset", 2),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("fails instead of hiding an unresolved current file-version pointer", async () => {
    const content = new ContentManagementService(scheduleTestEnv);
    await env.DB.prepare(
      `INSERT INTO file_assets (
         id, event_id, owner_person_id, target_type, target_id, asset_kind,
         current_version_id, status, created_at, updated_at
       ) VALUES ('content-dangling-current-asset', ?, ?, 'task',
                 'content-dangling-current-task', 'other',
                 'content-missing-current-version', 'active',
                 unixepoch(), unixepoch())`,
    )
      .bind(viewer.eventId, viewer.personId)
      .run();

    await expect(content.getDashboard(viewer)).rejects.toThrow(
      /references unavailable current version content-missing-current-version/i,
    );
  });
});
