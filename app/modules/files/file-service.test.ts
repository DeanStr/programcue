import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { headshotProfileRevisionGuardStatement } from "~/modules/speakers/speaker-profile-revision.server";
import { loader as adminSpeakerFileDownload } from "~/routes/admin-speaker-file-download";
import { loader as speakerFileDownload } from "~/routes/speaker-file-download";
import { loader as speakerResourceDownload } from "~/routes/speaker-resource-download";
import { FilePolicyError } from "./file-policy";
import {
  acceptTestFileScanDispatch,
  completeTestDirectUpload,
} from "./direct-upload.test-helper";
import {
  FileAccessError,
  FileDiscardIncompleteError,
  FileErasureConfirmationError,
  FileErasureIncompleteError,
  FileRetentionStateError,
  FileScanPendingError,
  FileService,
} from "./file-service.server";

const speaker: Viewer = {
  personId: "person-demo-speaker",
  name: "Priya Shah",
  email: "priya.speaker@example.com",
  role: "speaker",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};
const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};
const submitterOnly: Viewer = {
  ...speaker,
  personId: "file-submit-only-person",
  email: "file-submit-only@example.com",
  role: "submitter",
};

function routeContext() {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: env as unknown as CloudflareEnvironment,
    ctx: {} as ExecutionContext,
  });
  return context;
}

const ppt = "application/vnd.ms-powerpoint";
const pptx =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function concatenate(parts: Uint8Array[]) {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function emptyZip(entries: string[]) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry);
    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    localParts.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.byteLength;
  }
  const central = concatenate(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, central.byteLength, true);
  endView.setUint32(16, localOffset, true);
  return concatenate([...localParts, central, end]);
}

function compoundOfficeFile(streamName: string) {
  const bytes = new Uint8Array(1_536);
  const header = new DataView(bytes.buffer, 0, 512);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  header.setUint16(26, 3, true);
  header.setUint16(28, 0xfffe, true);
  header.setUint16(30, 9, true);
  header.setUint16(32, 6, true);
  header.setUint32(44, 1, true);
  header.setUint32(48, 0, true);
  header.setUint32(56, 4_096, true);
  header.setUint32(60, 0xfffffffe, true);
  header.setUint32(68, 0xfffffffe, true);
  bytes.fill(0xff, 76, 512);
  header.setUint32(76, 1, true);

  const directoryOffset = 512 + 128;
  for (let index = 0; index < streamName.length; index += 1)
    new DataView(bytes.buffer).setUint16(
      directoryOffset + index * 2,
      streamName.charCodeAt(index),
      true,
    );
  const directory = new DataView(bytes.buffer, directoryOffset, 128);
  directory.setUint16(64, (streamName.length + 1) * 2, true);
  bytes[directoryOffset + 66] = 2;

  bytes.fill(0xff, 1_024, 1_536);
  const fat = new DataView(bytes.buffer, 1_024, 512);
  fat.setUint32(0, 0xfffffffe, true);
  fat.setUint32(4, 0xfffffffd, true);
  return bytes;
}

describe("private R2 file lifecycle", () => {
  it("stores a signature-valid upload in quarantine and releases only after a clean scan", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new FileService(testEnv);
    const png = new File(
      [
        new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
        ]),
      ],
      "headshot.png",
      { type: "image/png" },
    );
    const uploaded = await completeTestDirectUpload(
      testEnv,
      speaker,
      {
        targetType: "person",
        targetId: speaker.personId,
        assetKind: "headshot",
      },
      png,
    );
    const version = await env.DB.prepare(
      "SELECT upload_status AS uploadStatus, signature_status AS signatureStatus, scan_status AS scanStatus, object_key AS objectKey FROM file_versions WHERE id = ?",
    )
      .bind(uploaded.versionId)
      .first<{
        uploadStatus: string;
        signatureStatus: string;
        scanStatus: string;
        objectKey: string;
      }>();
    expect(version).toMatchObject({
      uploadStatus: "uploaded",
      signatureStatus: "valid",
      scanStatus: "pending",
    });
    expect(await env.FILES.head(version!.objectKey)).not.toBeNull();
    await expect(
      service.participantDownload(speaker, uploaded.assetId),
    ).rejects.toBeInstanceOf(FileScanPendingError);

    await service.recordScanResult({
      ...(await acceptTestFileScanDispatch(
        testEnv,
        speaker.eventId,
        uploaded.versionId,
      )),
      eventId: speaker.eventId,
      versionId: uploaded.versionId,
      provider: "test-scanner",
      callbackId: `callback-${uploaded.versionId}`,
      status: "clean",
      result: { verdict: "clean" },
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT revision.headshot_file_version_id AS headshotFileVersionId,
                audit.actor_kind AS actorKind, audit.origin
           FROM speaker_profile_revisions revision
           JOIN audit_events audit
             ON audit.correlation_id = revision.correlation_id
            AND audit.entity_type = 'file_version'
          WHERE revision.person_id = ?
            AND revision.correlation_id = ?`,
      )
        .bind(speaker.personId, `file-scan:${uploaded.versionId}:attempt:1`)
        .first(),
    ).resolves.toEqual({
      headshotFileVersionId: uploaded.versionId,
      actorKind: "provider",
      origin: "provider_webhook",
    });
    const response = await service.participantDownload(
      speaker,
      uploaded.assetId,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
    const participantInline = await service.participantDownload(
      speaker,
      uploaded.assetId,
      { inlineHeadshot: true },
    );
    expect(participantInline.headers.get("content-disposition")).toBe(
      'inline; filename="headshot.png"',
    );
    const administratorResponse =
      await service.administratorSpeakerFileDownload(
        admin,
        speaker.personId,
        uploaded.assetId,
      );
    expect(administratorResponse.status).toBe(200);
    expect(administratorResponse.headers.get("content-disposition")).toContain(
      'filename="headshot.png"',
    );
    const administratorInline = await service.administratorSpeakerFileDownload(
      admin,
      speaker.personId,
      uploaded.assetId,
      { inlineHeadshot: true },
    );
    expect(administratorInline.headers.get("content-disposition")).toBe(
      'inline; filename="headshot.png"',
    );
    const participantInlineRoute = await speakerFileDownload({
      request: new Request(
        `http://localhost/participant/files/${uploaded.assetId}?view=headshot`,
        { headers: { cookie: "program_cue_demo_identity=speaker" } },
      ),
      params: { assetId: uploaded.assetId },
      context: routeContext(),
    } as never);
    expect(participantInlineRoute.headers.get("content-disposition")).toBe(
      'inline; filename="headshot.png"',
    );
    const administratorInlineRoute = await adminSpeakerFileDownload({
      request: new Request(
        `http://localhost/admin/speakers/${speaker.personId}/files/${uploaded.assetId}?view=headshot`,
        { headers: { cookie: "program_cue_demo_identity=administrator" } },
      ),
      params: { personId: speaker.personId, assetId: uploaded.assetId },
      context: routeContext(),
    } as never);
    expect(administratorInlineRoute.headers.get("content-disposition")).toBe(
      'inline; filename="headshot.png"',
    );
    await testEnv.DB.prepare(
      `UPDATE file_assets
          SET target_type = 'session', target_id = 'session-demo-speaker'
        WHERE id = ? AND event_id = ?`,
    )
      .bind(uploaded.assetId, speaker.eventId)
      .run();
    await expect(
      service.participantDownload(speaker, uploaded.assetId),
    ).resolves.toBeInstanceOf(Response);
    await expect(
      service.participantDownload(speaker, uploaded.assetId, {
        inlineHeadshot: true,
      }),
    ).rejects.toBeInstanceOf(FileScanPendingError);
    await expect(
      service.administratorSpeakerFileDownload(
        admin,
        speaker.personId,
        uploaded.assetId,
        { inlineHeadshot: true },
      ),
    ).rejects.toBeInstanceOf(FileAccessError);
    await testEnv.DB.prepare(
      `UPDATE file_assets
          SET target_type = 'person', target_id = ?
        WHERE id = ? AND event_id = ?`,
    )
      .bind(speaker.personId, uploaded.assetId, speaker.eventId)
      .run();
    await expect(
      service.administratorSpeakerFileDownload(
        admin,
        "person-demo-evaluator",
        uploaded.assetId,
      ),
    ).rejects.toBeInstanceOf(FileAccessError);
    const otherAssetId = `cross-asset-${crypto.randomUUID()}`;
    const otherVersionId = `cross-version-${crypto.randomUUID()}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status
         ) VALUES (?, ?, ?, 'person', ?, 'other', 'active')`,
      ).bind(otherAssetId, speaker.eventId, speaker.personId, speaker.personId),
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status,
           scan_status, released_at
         ) VALUES (?, ?, ?, 1, ?, 'other.pdf', 'application/pdf',
                   'application/pdf', 10, 'other-etag', 'uploaded', 'valid',
                   'clean', unixepoch())`,
      ).bind(
        otherVersionId,
        speaker.eventId,
        otherAssetId,
        `tests/${otherVersionId}`,
      ),
      testEnv.DB.prepare(
        "UPDATE file_assets SET current_version_id = ? WHERE id = ?",
      ).bind(otherVersionId, uploaded.assetId),
    ]);
    await expect(
      service.administratorSpeakerFileDownload(
        admin,
        speaker.personId,
        uploaded.assetId,
      ),
    ).rejects.toBeInstanceOf(FileAccessError);
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "UPDATE file_assets SET current_version_id = ? WHERE id = ?",
      ).bind(uploaded.versionId, uploaded.assetId),
      testEnv.DB.prepare("DELETE FROM file_assets WHERE id = ?").bind(
        otherAssetId,
      ),
    ]);
    await expect(
      service.participantDownload(
        {
          ...speaker,
          personId: "person-demo-evaluator",
          email: "jordan.evaluator@example.com",
        },
        uploaded.assetId,
      ),
    ).rejects.toBeInstanceOf(FileScanPendingError);
  });

  it("stores an administrator-uploaded headshot on the exact event speaker and preserves uploader attribution", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    await testEnv.DB.prepare(
      `DELETE FROM file_assets
        WHERE event_id = ? AND owner_person_id = ?
          AND target_type = 'person' AND target_id = ?
          AND asset_kind = 'headshot'`,
    )
      .bind(speaker.eventId, speaker.personId, speaker.personId)
      .run();
    const target = {
      targetType: "person" as const,
      targetId: speaker.personId,
      assetKind: "headshot" as const,
    };
    const image = (name: string, marker: number) =>
      new File(
        [
          new Uint8Array([
            0x89,
            0x50,
            0x4e,
            0x47,
            0x0d,
            0x0a,
            0x1a,
            0x0a,
            marker,
          ]),
        ],
        name,
        { type: "image/png" },
      );

    const administratorUpload = await completeTestDirectUpload(
      testEnv,
      admin,
      target,
      image("organizer-headshot.png", 1),
    );
    const participantReplacement = await completeTestDirectUpload(
      testEnv,
      speaker,
      target,
      image("speaker-headshot.png", 2),
    );

    expect(participantReplacement.assetId).toBe(administratorUpload.assetId);
    expect(participantReplacement.versionNumber).toBe(2);
    await expect(
      testEnv.DB.prepare(
        `SELECT asset.owner_person_id AS ownerPersonId,
                first.created_by_person_id AS firstUploader,
                second.created_by_person_id AS secondUploader
           FROM file_assets asset
           JOIN file_versions first
             ON first.asset_id = asset.id AND first.version_number = 1
           JOIN file_versions second
             ON second.asset_id = asset.id AND second.version_number = 2
          WHERE asset.id = ? AND asset.event_id = ?
            AND asset.target_type = 'person' AND asset.target_id = ?`,
      )
        .bind(administratorUpload.assetId, speaker.eventId, speaker.personId)
        .first(),
    ).resolves.toEqual({
      ownerPersonId: speaker.personId,
      firstUploader: admin.personId,
      secondUploader: speaker.personId,
    });
    await expect(
      new FileService(testEnv).assertAdminTarget(admin, {
        ...target,
        targetId: "person-demo-evaluator",
      }),
    ).rejects.toBeInstanceOf(FileAccessError);
    await expect(
      new FileService(testEnv).assertAdminTarget(admin, {
        ...target,
        assetKind: "slides",
      }),
    ).rejects.toThrow(/limited to speaker headshots/i);
    await expect(
      new FileService(testEnv).assertParticipantTarget(speaker, {
        targetType: "session",
        targetId: "session-demo-speaker",
        assetKind: "headshot",
      }),
    ).rejects.toThrow(/headshots must be uploaded to the participant profile/i);
  });

  it("downloads released headshots for active workflow-only prospects and denies inactive workflows", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new FileService(testEnv);
    const suffix = crypto.randomUUID();
    const personId = `workflow-headshot-person-${suffix}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (id, email, display_name)
         VALUES (?, ?, 'Workflow-only prospect')`,
      ).bind(personId, `workflow-headshot-${suffix}@example.com`),
      testEnv.DB.prepare(
        `INSERT INTO event_speaker_workflows (
           event_id, person_id, status, source, last_operation_id,
           updated_by_person_id
         ) VALUES (?, ?, 'prospect', 'manual', ?, ?)`,
      ).bind(
        admin.eventId,
        personId,
        `workflow-headshot:${suffix}`,
        admin.personId,
      ),
    ]);

    const uploaded = await completeTestDirectUpload(
      testEnv,
      admin,
      {
        targetType: "person",
        targetId: personId,
        assetKind: "headshot",
      },
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])],
        "workflow-prospect.png",
        { type: "image/png" },
      ),
    );
    await expect(
      service.administratorSpeakerFileDownload(
        admin,
        personId,
        uploaded.assetId,
      ),
    ).rejects.toBeInstanceOf(FileAccessError);

    await service.recordScanResult({
      ...(await acceptTestFileScanDispatch(
        testEnv,
        admin.eventId,
        uploaded.versionId,
      )),
      eventId: admin.eventId,
      versionId: uploaded.versionId,
      provider: "test-scanner",
      callbackId: `callback-${uploaded.versionId}`,
      status: "clean",
      result: { verdict: "clean" },
    });

    const download = await service.administratorSpeakerFileDownload(
      admin,
      personId,
      uploaded.assetId,
    );
    expect(download.headers.get("content-disposition")).toBe(
      'attachment; filename="workflow-prospect.png"',
    );
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    await expect(
      service.administratorSpeakerFileDownload(
        { ...admin, eventId: `other-event-${suffix}` },
        personId,
        uploaded.assetId,
      ),
    ).rejects.toBeInstanceOf(FileAccessError);
    await expect(
      service.administratorSpeakerFileDownload(
        { ...admin, organisationId: `other-organisation-${suffix}` },
        personId,
        uploaded.assetId,
      ),
    ).rejects.toBeInstanceOf(FileAccessError);

    for (const status of ["invited", "confirmed"] as const) {
      await testEnv.DB.prepare(
        `UPDATE event_speaker_workflows SET status = ?, updated_at = unixepoch()
          WHERE event_id = ? AND person_id = ?`,
      )
        .bind(status, admin.eventId, personId)
        .run();
      const view = await adminSpeakerFileDownload({
        request: new Request(
          `http://localhost/admin/speakers/${personId}/files/${uploaded.assetId}?view=headshot`,
          { headers: { cookie: "program_cue_demo_identity=administrator" } },
        ),
        params: { personId, assetId: uploaded.assetId },
        context: routeContext(),
      } as never);
      expect(view.headers.get("content-disposition")).toBe(
        'inline; filename="workflow-prospect.png"',
      );
    }

    for (const status of ["declined", "withdrawn"] as const) {
      await testEnv.DB.prepare(
        `UPDATE event_speaker_workflows SET status = ?, updated_at = unixepoch()
          WHERE event_id = ? AND person_id = ?`,
      )
        .bind(status, admin.eventId, personId)
        .run();
      await expect(
        service.assertAdminTarget(admin, {
          targetType: "person",
          targetId: personId,
          assetKind: "headshot",
        }),
      ).rejects.toThrow(/speaker upload target not found/i);
      await expect(
        adminSpeakerFileDownload({
          request: new Request(
            `http://localhost/admin/speakers/${personId}/files/${uploaded.assetId}`,
            { headers: { cookie: "program_cue_demo_identity=administrator" } },
          ),
          params: { personId, assetId: uploaded.assetId },
          context: routeContext(),
        } as never),
      ).rejects.toMatchObject({ status: 404 });
    }
  });

  it("refuses private downloads when R2 bytes no longer match the scanned object ETag", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new FileService(testEnv);
    const release = async (
      actor: Viewer,
      target: Parameters<typeof completeTestDirectUpload>[2],
      file: File,
    ) => {
      const upload = await completeTestDirectUpload(
        testEnv,
        actor,
        target,
        file,
      );
      await service.recordScanResult({
        ...(await acceptTestFileScanDispatch(
          testEnv,
          actor.eventId,
          upload.versionId,
        )),
        eventId: actor.eventId,
        versionId: upload.versionId,
        provider: "test-scanner",
        callbackId: `callback-${upload.versionId}`,
        status: "clean",
        result: { verdict: "clean" },
      });
      const stored = await testEnv.DB.prepare(
        "SELECT object_key AS objectKey FROM file_versions WHERE id = ? AND event_id = ?",
      )
        .bind(upload.versionId, actor.eventId)
        .first<{ objectKey: string }>();
      expect(stored).not.toBeNull();
      return { ...upload, objectKey: stored!.objectKey };
    };
    const overwrite = (objectKey: string, marker: string) =>
      testEnv.FILES.put(objectKey, `%PDF-1.7 unscanned overwrite ${marker}`);

    const profile = await release(
      speaker,
      {
        targetType: "person",
        targetId: speaker.personId,
        assetKind: "headshot",
      },
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 91])],
        "verified-profile.png",
        { type: "image/png" },
      ),
    );
    expect(
      (await service.participantDownload(speaker, profile.assetId)).status,
    ).toBe(200);
    await overwrite(profile.objectKey, "profile");
    await expect(
      service.participantDownload(speaker, profile.assetId),
    ).rejects.toThrow(/no longer matches its scanned version/u);

    const evidence = await release(
      speaker,
      {
        targetType: "task",
        targetId: "task-demo-slides",
        assetKind: "task_evidence",
      },
      new File(["%PDF-1.7 verified task evidence"], "verified-evidence.pdf", {
        type: "application/pdf",
      }),
    );
    const evidenceId = crypto.randomUUID();
    await testEnv.DB.prepare(
      `INSERT INTO task_evidence (
         id, event_id, task_id, submitted_by_person_id, file_asset_id,
         evidence_json, status, created_at
       ) VALUES (?, ?, 'task-demo-slides', ?, ?, ?, 'submitted', unixepoch())`,
    )
      .bind(
        evidenceId,
        speaker.eventId,
        speaker.personId,
        evidence.assetId,
        JSON.stringify({ fileVersionId: evidence.versionId }),
      )
      .run();
    expect(
      (
        await service.administratorTaskEvidenceDownload(
          admin,
          evidence.assetId,
          evidence.versionId,
        )
      ).status,
    ).toBe(200);
    await overwrite(evidence.objectKey, "task evidence");
    await expect(
      service.administratorTaskEvidenceDownload(
        admin,
        evidence.assetId,
        evidence.versionId,
      ),
    ).rejects.toThrow(/no longer matches its scanned version/u);

    const resource = await release(
      admin,
      {
        targetType: "resource",
        targetId: "resource-speaker-handbook",
        assetKind: "resource_attachment",
      },
      new File(["%PDF-1.7 verified resource"], "verified-resource.pdf", {
        type: "application/pdf",
      }),
    );
    await testEnv.DB.prepare(
      `INSERT INTO resource_attachments (
         resource_page_version_id, event_id, file_asset_id, position, label
       ) VALUES ('resource-version-handbook-1', ?, ?, 0, 'Verified resource')`,
    )
      .bind(speaker.eventId, resource.assetId)
      .run();
    expect(
      (await service.participantResourceDownload(speaker, resource.assetId))
        .status,
    ).toBe(200);
    await expect(
      service.participantResourceDownload(submitterOnly, resource.assetId),
    ).rejects.toThrow(/outside your audience/u);
    await overwrite(resource.objectKey, "resource");
    await expect(
      service.participantResourceDownload(speaker, resource.assetId),
    ).rejects.toThrow(/no longer matches its scanned version/u);

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "DELETE FROM task_evidence WHERE id = ? AND event_id = ?",
      ).bind(evidenceId, speaker.eventId),
      testEnv.DB.prepare(
        `DELETE FROM resource_attachments
          WHERE resource_page_version_id = 'resource-version-handbook-1'
            AND event_id = ? AND file_asset_id = ?`,
      ).bind(speaker.eventId, resource.assetId),
      testEnv.DB.prepare(
        "DELETE FROM file_assets WHERE id = ? AND event_id = ?",
      ).bind(evidence.assetId, speaker.eventId),
      testEnv.DB.prepare(
        "DELETE FROM file_assets WHERE id = ? AND event_id = ?",
      ).bind(resource.assetId, speaker.eventId),
    ]);
    await testEnv.FILES.delete([evidence.objectKey, resource.objectKey]);
  });

  it("fails closed when a released file has no detected content type", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new FileService(testEnv);
    const uploaded = await completeTestDirectUpload(
      testEnv,
      speaker,
      {
        targetType: "task",
        targetId: "task-demo-slides",
        assetKind: "task_evidence",
      },
      new File(["%PDF-1.7 released evidence"], "released-evidence.pdf", {
        type: "application/pdf",
      }),
    );
    await service.recordScanResult({
      ...(await acceptTestFileScanDispatch(
        testEnv,
        speaker.eventId,
        uploaded.versionId,
      )),
      eventId: speaker.eventId,
      versionId: uploaded.versionId,
      provider: "test-scanner",
      callbackId: `callback-${uploaded.versionId}`,
      status: "clean",
      result: { verdict: "clean" },
    });
    await testEnv.DB.prepare(
      "UPDATE file_versions SET detected_content_type = NULL WHERE id = ? AND event_id = ?",
    )
      .bind(uploaded.versionId, speaker.eventId)
      .run();

    await expect(
      service.participantDownload(speaker, uploaded.assetId),
    ).rejects.toThrow(/missing its detected content type/i);
  });

  it("returns the complete participant evidence history beyond twenty versions", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new FileService(testEnv);
    const assetId = crypto.randomUUID();
    await testEnv.DB.prepare(
      `INSERT INTO file_assets (
         id, event_id, owner_person_id, target_type, target_id, asset_kind,
         status
       ) VALUES (?, ?, ?, 'task', 'task-demo-slides', 'task_evidence',
                 'active')`,
    )
      .bind(assetId, speaker.eventId, speaker.personId)
      .run();
    const statements: D1PreparedStatement[] = [];
    for (let versionNumber = 1; versionNumber <= 21; versionNumber += 1) {
      const versionId = `${assetId}-version-${versionNumber}`;
      statements.push(
        testEnv.DB.prepare(
          `INSERT INTO file_versions (
             id, event_id, asset_id, version_number, object_key,
             original_filename, declared_content_type, size_bytes,
             upload_status, signature_status, scan_status,
             created_by_person_id
           ) VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', 10,
                     'uploaded', 'valid', 'clean', ?)`,
        ).bind(
          versionId,
          speaker.eventId,
          assetId,
          versionNumber,
          `tests/${versionId}`,
          `evidence-${versionNumber}.pdf`,
          speaker.personId,
        ),
        testEnv.DB.prepare(
          `INSERT INTO task_evidence (
             id, event_id, task_id, submitted_by_person_id, file_asset_id,
             evidence_json, status
           ) VALUES (?, ?, 'task-demo-slides', ?, ?, ?, 'submitted')`,
        ).bind(
          `${assetId}-evidence-${versionNumber}`,
          speaker.eventId,
          speaker.personId,
          assetId,
          JSON.stringify({ fileVersionId: versionId }),
        ),
      );
    }
    await testEnv.DB.batch(statements);

    const versions = await service.listParticipantTaskEvidenceVersions(
      speaker,
      ["task-demo-slides"],
    );
    expect(
      versions.filter((version) => version.assetId === assetId),
    ).toHaveLength(21);
  });

  it("returns explicit HTTP states for unavailable speaker downloads", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    await env.DB.prepare(
      `
      DELETE FROM file_assets
       WHERE event_id = ? AND owner_person_id = ?
         AND target_type = 'person' AND target_id = ? AND asset_kind = 'headshot'
    `,
    )
      .bind(speaker.eventId, speaker.personId, speaker.personId)
      .run();
    const uploaded = await completeTestDirectUpload(
      testEnv,
      speaker,
      {
        targetType: "person",
        targetId: speaker.personId,
        assetKind: "headshot",
      },
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])],
        "pending.png",
        { type: "image/png" },
      ),
    );

    await expect(
      speakerFileDownload({
        request: new Request(
          `http://localhost/participant/files/${uploaded.assetId}`,
          { headers: { cookie: "program_cue_demo_identity=speaker" } },
        ),
        params: { assetId: uploaded.assetId },
        context: routeContext(),
      } as never),
    ).rejects.toMatchObject({ status: 423 });
    await expect(
      speakerResourceDownload({
        request: new Request(
          "http://localhost/participant/resources/missing/download",
          { headers: { cookie: "program_cue_demo_identity=speaker" } },
        ),
        params: { assetId: `missing-${crypto.randomUUID()}` },
        context: routeContext(),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects mismatched content before writing bytes to R2", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const file = new File(["not a PDF"], "slides.pdf", {
      type: "application/pdf",
    });
    await expect(
      completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "person",
          targetId: speaker.personId,
          assetKind: "slides",
        },
        file,
      ),
    ).rejects.toBeInstanceOf(FilePolicyError);
    const failed = await env.DB.prepare(
      "SELECT upload_status AS uploadStatus, signature_status AS signatureStatus, scan_status AS scanStatus, scan_error AS scanError, object_key AS objectKey FROM file_versions WHERE original_filename = 'slides.pdf'",
    ).first<{
      uploadStatus: string;
      signatureStatus: string;
      scanStatus: string;
      scanError: string | null;
      objectKey: string;
    }>();
    expect(failed).toMatchObject({
      uploadStatus: "failed",
      signatureStatus: "invalid",
      scanStatus: "failed",
      scanError: "Completed object failed signature validation.",
    });
    expect(await env.FILES.head(failed!.objectKey)).toBeNull();
  });

  it("identifies Office uploads from container metadata instead of the filename", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const target = {
      targetType: "person" as const,
      targetId: speaker.personId,
      assetKind: "slides" as const,
    };
    const valid = await completeTestDirectUpload(
      testEnv,
      speaker,
      target,
      new File(
        [
          emptyZip([
            "[Content_Types].xml",
            "_rels/.rels",
            "ppt/presentation.xml",
          ]),
        ],
        "metadata-validated.pptx",
        { type: pptx },
      ),
    );
    expect(
      await testEnv.DB.prepare(
        "SELECT detected_content_type AS detected FROM file_versions WHERE id = ?",
      )
        .bind(valid.versionId)
        .first(),
    ).toEqual({ detected: pptx });

    await expect(
      completeTestDirectUpload(
        testEnv,
        speaker,
        target,
        new File([emptyZip(["payload.txt"])], "renamed-archive.pptx", {
          type: pptx,
        }),
      ),
    ).rejects.toBeInstanceOf(FilePolicyError);
    await expect(
      completeTestDirectUpload(
        testEnv,
        speaker,
        target,
        new File(
          [
            emptyZip([
              "[Content_Types].xml",
              "_rels/.rels",
              "word/document.xml",
            ]),
          ],
          "renamed-document.pptx",
          { type: pptx },
        ),
      ),
    ).rejects.toBeInstanceOf(FilePolicyError);
    await expect(
      completeTestDirectUpload(
        testEnv,
        speaker,
        target,
        new File(
          [compoundOfficeFile("WordDocument")],
          "renamed-legacy-document.ppt",
          { type: ppt },
        ),
      ),
    ).rejects.toBeInstanceOf(FilePolicyError);
    const legacy = await completeTestDirectUpload(
      testEnv,
      speaker,
      target,
      new File(
        [compoundOfficeFile("PowerPoint Document")],
        "metadata-validated.ppt",
        { type: ppt },
      ),
    );
    expect(
      await testEnv.DB.prepare(
        "SELECT detected_content_type AS detected FROM file_versions WHERE id = ?",
      )
        .bind(legacy.versionId)
        .first(),
    ).toEqual({ detected: ppt });
  });

  it("does not let a slower clean callback replace a newer clean version", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new FileService(testEnv);
    const upload = (name: string, marker: number) =>
      completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "person",
          targetId: speaker.personId,
          assetKind: "headshot",
        },
        new File(
          [
            new Uint8Array([
              0x89,
              0x50,
              0x4e,
              0x47,
              0x0d,
              0x0a,
              0x1a,
              0x0a,
              marker,
            ]),
          ],
          name,
          { type: "image/png" },
        ),
      );
    const older = await upload("older.png", 1);
    const newer = await upload("newer.png", 2);
    expect(newer.assetId).toBe(older.assetId);
    expect(newer.versionNumber).toBeGreaterThan(older.versionNumber);

    await service.recordScanResult({
      ...(await acceptTestFileScanDispatch(
        testEnv,
        speaker.eventId,
        newer.versionId,
      )),
      eventId: speaker.eventId,
      versionId: newer.versionId,
      provider: "test-scanner",
      callbackId: `callback-${newer.versionId}`,
      status: "clean",
      result: { verdict: "clean", callback: "first" },
    });
    await service.recordScanResult({
      ...(await acceptTestFileScanDispatch(
        testEnv,
        speaker.eventId,
        older.versionId,
      )),
      eventId: speaker.eventId,
      versionId: older.versionId,
      provider: "test-scanner",
      callbackId: `callback-${older.versionId}`,
      status: "clean",
      result: { verdict: "clean", callback: "late" },
    });

    const asset = await testEnv.DB.prepare(
      "SELECT current_version_id AS currentVersionId, status FROM file_assets WHERE id = ?",
    )
      .bind(older.assetId)
      .first<{ currentVersionId: string; status: string }>();
    expect(asset).toEqual({
      currentVersionId: newer.versionId,
      status: "active",
    });
    const latest = await testEnv.DB.prepare(
      "SELECT scan_status AS scanStatus, replaced_at AS replacedAt FROM file_versions WHERE id = ?",
    )
      .bind(newer.versionId)
      .first<{ scanStatus: string; replacedAt: number | null }>();
    expect(latest).toEqual({ scanStatus: "clean", replacedAt: null });
  });

  it("serializes concurrent versions onto one logical profile asset", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const previous = await testEnv.DB.prepare(
      `SELECT COALESCE(MAX(fv.version_number), 0) AS versionNumber
         FROM file_assets fa
         LEFT JOIN file_versions fv ON fv.asset_id = fa.id
        WHERE fa.event_id = ? AND fa.owner_person_id = ?
          AND fa.target_type = 'person' AND fa.target_id = ?
          AND fa.asset_kind = 'headshot' AND fa.status <> 'deleted'`,
    )
      .bind(speaker.eventId, speaker.personId, speaker.personId)
      .first<{ versionNumber: number }>();
    const uploads = await Promise.all(
      [1, 2, 3, 4].map((marker) =>
        completeTestDirectUpload(
          testEnv,
          speaker,
          {
            targetType: "person",
            targetId: speaker.personId,
            assetKind: "headshot",
          },
          new File(
            [
              new Uint8Array([
                0x89,
                0x50,
                0x4e,
                0x47,
                0x0d,
                0x0a,
                0x1a,
                0x0a,
                marker,
              ]),
            ],
            `concurrent-${marker}.png`,
            { type: "image/png" },
          ),
        ),
      ),
    );

    expect(new Set(uploads.map((upload) => upload.assetId)).size).toBe(1);
    const firstVersion = Number(previous?.versionNumber ?? 0) + 1;
    expect(uploads.map((upload) => upload.versionNumber).sort()).toEqual([
      firstVersion,
      firstVersion + 1,
      firstVersion + 2,
      firstVersion + 3,
    ]);
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM file_assets
          WHERE event_id = ? AND owner_person_id = ? AND target_type = 'person'
            AND target_id = ? AND asset_kind = 'headshot' AND status <> 'deleted'`,
      )
        .bind(speaker.eventId, speaker.personId, speaker.personId)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("creates an immutable asset for each resource attachment upload", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const upload = (name: string) =>
      completeTestDirectUpload(
        testEnv,
        admin,
        {
          targetType: "resource",
          targetId: "resource-speaker-handbook",
          assetKind: "resource_attachment",
        },
        new File([`%PDF-1.7 ${name}`], name, { type: "application/pdf" }),
      );

    const first = await upload("first.pdf");
    const second = await upload("second.pdf");

    expect(second.assetId).not.toBe(first.assetId);
    expect(first.versionNumber).toBe(1);
    expect(second.versionNumber).toBe(1);
    const assets = await testEnv.DB.prepare(
      `
      SELECT COUNT(*) AS count FROM file_assets
       WHERE event_id = ? AND target_type = 'resource' AND target_id = ?
         AND asset_kind = 'resource_attachment'
    `,
    )
      .bind(admin.eventId, "resource-speaker-handbook")
      .first<{ count: number }>();
    expect(assets?.count).toBe(2);
  });

  it("retries private-object cleanup after an unattached upload was durably revoked", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const upload = await completeTestDirectUpload(
      testEnv,
      admin,
      {
        targetType: "resource",
        targetId: "resource-speaker-handbook",
        assetKind: "resource_attachment",
      },
      new File(["%PDF-1.7 unattached cleanup"], "unattached-cleanup.pdf", {
        type: "application/pdf",
      }),
    );
    const stored = await testEnv.DB.prepare(
      "SELECT object_key AS objectKey FROM file_versions WHERE id = ?",
    )
      .bind(upload.versionId)
      .first<{ objectKey: string }>();
    const failingBucket = new Proxy(testEnv.FILES, {
      get(target, property) {
        if (property === "delete") {
          return async () => {
            throw new Error("injected unattached R2 delete failure");
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failingEnvironment = new Proxy(testEnv, {
      get(target, property) {
        return property === "FILES"
          ? failingBucket
          : Reflect.get(target, property);
      },
    });

    await expect(
      new FileService(failingEnvironment).discardUnattachedResourceUpload(
        admin,
        upload,
      ),
    ).rejects.toMatchObject({
      name: FileDiscardIncompleteError.name,
      committed: true,
      operationId: `file-upload-discard:${upload.versionId}`,
    });
    expect(await testEnv.FILES.head(stored!.objectKey)).not.toBeNull();
    expect(
      await testEnv.DB.prepare(
        `SELECT asset.status, version.deleted_at AS deletedAt,
                (SELECT COUNT(*) FROM audit_events
                  WHERE id = ?) AS discardAudits
           FROM file_assets asset
           JOIN file_versions version
             ON version.asset_id = asset.id AND version.event_id = asset.event_id
          WHERE asset.id = ? AND version.id = ?`,
      )
        .bind(
          `file-upload-discarded:${upload.versionId}`,
          upload.assetId,
          upload.versionId,
        )
        .first(),
    ).toEqual({
      status: "deleted",
      deletedAt: expect.any(Number),
      discardAudits: 1,
    });

    await expect(
      new FileService(testEnv).discardUnattachedResourceUpload(admin, upload),
    ).resolves.toBeUndefined();
    expect(await testEnv.FILES.head(stored!.objectKey)).toBeNull();
  });

  it("rejects a task upload before storage when the task is final", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    await testEnv.DB.prepare(
      `
      UPDATE task_instances SET status = 'completed', revision = revision + 1
       WHERE id = 'task-demo-slides' AND event_id = ?
    `,
    )
      .bind(speaker.eventId)
      .run();
    const before = await testEnv.DB.prepare(
      `
      SELECT COUNT(*) AS count FROM file_versions fv
      JOIN file_assets fa ON fa.id = fv.asset_id AND fa.event_id = fv.event_id
       WHERE fa.event_id = ? AND fa.target_type = 'task' AND fa.target_id = 'task-demo-slides'
    `,
    )
      .bind(speaker.eventId)
      .first<{ count: number }>();

    await expect(
      completeTestDirectUpload(
        testEnv,
        speaker,
        {
          targetType: "task",
          targetId: "task-demo-slides",
          assetKind: "task_evidence",
        },
        new File(
          [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])],
          "too-late.png",
          { type: "image/png" },
        ),
      ),
    ).rejects.toBeInstanceOf(FileAccessError);
    const after = await testEnv.DB.prepare(
      `
      SELECT COUNT(*) AS count FROM file_versions fv
      JOIN file_assets fa ON fa.id = fv.asset_id AND fa.event_id = fv.event_id
       WHERE fa.event_id = ? AND fa.target_type = 'task' AND fa.target_id = 'task-demo-slides'
    `,
    )
      .bind(speaker.eventId)
      .first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it("revokes and erases every private version before allowing a new logical file generation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new FileService(testEnv);
    const target = {
      targetType: "person" as const,
      targetId: speaker.personId,
      assetKind: "supporting_document" as const,
    };
    const first = await completeTestDirectUpload(
      testEnv,
      speaker,
      target,
      new File(["%PDF-1.7 erase first"], "erase-first.pdf", {
        type: "application/pdf",
      }),
    );
    const second = await completeTestDirectUpload(
      testEnv,
      speaker,
      target,
      new File(["%PDF-1.7 erase second"], "erase-second.pdf", {
        type: "application/pdf",
      }),
    );
    const stored = await testEnv.DB.prepare(
      "SELECT object_key AS objectKey FROM file_versions WHERE asset_id = ? ORDER BY version_number",
    )
      .bind(first.assetId)
      .all<{ objectKey: string }>();

    await expect(
      service.eraseAsset(speaker, {
        assetId: first.assetId,
        confirmed: false,
      }),
    ).rejects.toBeInstanceOf(FileErasureConfirmationError);
    const erased = await service.eraseAsset(speaker, {
      assetId: first.assetId,
      confirmed: true,
    });
    expect(erased).toMatchObject({
      duplicate: false,
      erasedVersions: 2,
      affected: { latestFilename: "erase-second.pdf", versionCount: 2 },
    });
    for (const version of stored.results) {
      expect(await testEnv.FILES.head(version.objectKey)).toBeNull();
    }
    expect(
      await testEnv.DB.prepare(
        `SELECT fa.status, fa.current_version_id AS currentVersionId,
                SUM(fv.deleted_at IS NOT NULL) AS deletedVersions,
                SUM(fv.released_at IS NOT NULL) AS releasedVersions
           FROM file_assets fa JOIN file_versions fv ON fv.asset_id = fa.id
          WHERE fa.id = ? GROUP BY fa.id`,
      )
        .bind(first.assetId)
        .first(),
    ).toEqual({
      status: "deleted",
      currentVersionId: null,
      deletedVersions: 2,
      releasedVersions: 0,
    });
    await expect(
      service.eraseAsset(speaker, {
        assetId: first.assetId,
        confirmed: true,
      }),
    ).resolves.toMatchObject({ duplicate: true, changeSequence: null });

    const replacement = await completeTestDirectUpload(
      testEnv,
      speaker,
      target,
      new File(["%PDF-1.7 after erasure"], "after-erasure.pdf", {
        type: "application/pdf",
      }),
    );
    expect(replacement.assetId).not.toBe(first.assetId);
    expect(replacement.versionNumber).toBe(1);
    expect(await testEnv.FILES.head(stored.results[0]!.objectKey)).toBeNull();
    expect(second.assetId).toBe(first.assetId);
  });

  it("keeps a durable tombstone and supports an idempotent retry when R2 erasure fails", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new FileService(testEnv);
    const upload = await completeTestDirectUpload(
      testEnv,
      admin,
      {
        targetType: "resource",
        targetId: "resource-speaker-handbook",
        assetKind: "resource_attachment",
      },
      new File(["%PDF-1.7 erasure retry"], "erasure-retry.pdf", {
        type: "application/pdf",
      }),
    );
    const stored = await testEnv.DB.prepare(
      "SELECT object_key AS objectKey FROM file_versions WHERE id = ?",
    )
      .bind(upload.versionId)
      .first<{ objectKey: string }>();
    const failingBucket = new Proxy(testEnv.FILES, {
      get(target, property) {
        if (property === "delete") {
          return async () => {
            throw new Error("injected R2 delete failure");
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failingEnvironment = new Proxy(testEnv, {
      get(target, property) {
        return property === "FILES"
          ? failingBucket
          : Reflect.get(target, property);
      },
    });

    await expect(
      new FileService(failingEnvironment).eraseAsset(admin, {
        assetId: upload.assetId,
        confirmed: true,
      }),
    ).rejects.toBeInstanceOf(FileErasureIncompleteError);
    expect(
      await testEnv.DB.prepare(
        "SELECT status, current_version_id AS currentVersionId FROM file_assets WHERE id = ?",
      )
        .bind(upload.assetId)
        .first(),
    ).toEqual({ status: "rejected", currentVersionId: null });
    expect(await testEnv.FILES.head(stored!.objectKey)).not.toBeNull();
    const committedChange = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count, MAX(sequence) AS sequence
         FROM event_changes
        WHERE event_id = ? AND entity_type = 'file_asset'
          AND entity_id = ? AND correlation_id = ?`,
    )
      .bind(admin.eventId, upload.assetId, `file-erasure:${upload.assetId}`)
      .first<{ count: number; sequence: number }>();
    expect(committedChange).toMatchObject({ count: 1 });

    const retried = await service.eraseAsset(admin, {
      assetId: upload.assetId,
      confirmed: true,
    });
    expect(retried).toMatchObject({
      duplicate: false,
      erasedVersions: 1,
      changeSequence: committedChange!.sequence,
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM event_changes
          WHERE event_id = ? AND entity_type = 'file_asset'
            AND entity_id = ? AND correlation_id = ?`,
      )
        .bind(admin.eventId, upload.assetId, `file-erasure:${upload.assetId}`)
        .first(),
    ).resolves.toEqual({ count: 1 });
    expect(await testEnv.FILES.head(stored!.objectKey)).toBeNull();
  });

  it("enforces owner-controlled holds and event retention before bounded erasure", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const eventId = `retention-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         retention_months, file_policy_json
       ) VALUES (?, ?, 'Expired retention event', ?, 'UTC',
                 unixepoch('2020-01-01T00:00:00Z'),
                 unixepoch('2020-01-02T00:00:00Z'), 12,
                 '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')`,
    )
      .bind(
        eventId,
        speaker.organisationId,
        `expired-retention-${crypto.randomUUID()}`,
      )
      .run();
    const eventSpeaker = { ...speaker, eventId };
    const owner = { ...admin, role: "owner" as const, eventId };
    const service = new FileService(testEnv);
    const upload = await completeTestDirectUpload(
      testEnv,
      eventSpeaker,
      {
        targetType: "person",
        targetId: speaker.personId,
        assetKind: "headshot",
      },
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 50])],
        "expired-file.png",
        { type: "image/png" },
      ),
    );
    await expect(service.getFileRetentionState(admin)).rejects.toBeInstanceOf(
      FileAccessError,
    );
    await service.setFileRetentionHold(owner, {
      hold: true,
      confirmed: true,
      reason: "Pending a legal discovery request",
    });
    await expect(
      service.eraseExpiredEventFiles(owner, { confirmed: true }),
    ).rejects.toBeInstanceOf(FileRetentionStateError);
    await service.setFileRetentionHold(owner, {
      hold: false,
      confirmed: true,
      reason: "Legal discovery request resolved",
    });

    await expect(
      service.eraseExpiredEventFiles(owner, { confirmed: true, limit: 50 }),
    ).resolves.toEqual({
      erasedAssets: 1,
      erasedVersions: 1,
      remainingAssets: 0,
    });
    expect(
      await testEnv.DB.prepare("SELECT status FROM file_assets WHERE id = ?")
        .bind(upload.assetId)
        .first(),
    ).toEqual({ status: "deleted" });
  });

  it("stops retention erasure when a hold is placed at the durable intent boundary", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const eventId = `retention-hold-race-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         retention_months, file_policy_json
       ) VALUES (?, ?, 'Retention hold race', ?, 'UTC',
                 unixepoch('2020-01-01T00:00:00Z'),
                 unixepoch('2020-01-02T00:00:00Z'), 12,
                 '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')`,
    )
      .bind(
        eventId,
        speaker.organisationId,
        `retention-hold-race-${crypto.randomUUID()}`,
      )
      .run();
    const eventSpeaker = { ...speaker, eventId };
    const owner = { ...admin, role: "owner" as const, eventId };
    const upload = await completeTestDirectUpload(
      testEnv,
      eventSpeaker,
      {
        targetType: "person",
        targetId: speaker.personId,
        assetKind: "headshot",
      },
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 51])],
        "held-before-intent.png",
        { type: "image/png" },
      ),
    );
    const stored = await testEnv.DB.prepare(
      "SELECT object_key AS objectKey FROM file_versions WHERE id = ?",
    )
      .bind(upload.versionId)
      .first<{ objectKey: string }>();
    let injectHold = true;
    const racingDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (injectHold) {
              injectHold = false;
              await target
                .prepare(
                  "UPDATE events SET file_retention_hold_at = unixepoch() WHERE id = ?",
                )
                .bind(eventId)
                .run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const racingEnvironment = new Proxy(testEnv, {
      get(target, property) {
        return property === "DB" ? racingDb : Reflect.get(target, property);
      },
    });

    await expect(
      new FileService(racingEnvironment).eraseExpiredEventFiles(owner, {
        confirmed: true,
      }),
    ).rejects.toThrow(
      "File retention was placed on hold before the erasure intent committed.",
    );
    expect(await testEnv.FILES.head(stored!.objectKey)).not.toBeNull();
    expect(
      await testEnv.DB.prepare(
        `SELECT asset.status,
                (SELECT COUNT(*) FROM audit_events audit
                  WHERE audit.id = 'file-erasure:' || asset.id) AS erasureRequests
           FROM file_assets asset WHERE asset.id = ?`,
      )
        .bind(upload.assetId)
        .first(),
    ).toEqual({ status: "pending", erasureRequests: 0 });
  });

  it("records removal when a released public headshot is erased", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new FileService(testEnv);
    const uploaded = await completeTestDirectUpload(
      testEnv,
      speaker,
      {
        targetType: "person",
        targetId: speaker.personId,
        assetKind: "headshot",
      },
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 52])],
        "headshot-before-erasure.png",
        { type: "image/png" },
      ),
    );
    await service.recordScanResult({
      ...(await acceptTestFileScanDispatch(
        testEnv,
        speaker.eventId,
        uploaded.versionId,
      )),
      eventId: speaker.eventId,
      versionId: uploaded.versionId,
      provider: "test-scanner",
      callbackId: `callback-${uploaded.versionId}`,
      status: "clean",
      result: { verdict: "clean" },
    });

    await service.eraseAsset(speaker, {
      assetId: uploaded.assetId,
      confirmed: true,
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT headshot_file_version_id AS headshotFileVersionId
           FROM speaker_profile_revisions
          WHERE person_id = ? AND correlation_id = ?`,
      )
        .bind(speaker.personId, `file-erasure:${uploaded.assetId}`)
        .first(),
    ).resolves.toEqual({ headshotFileVersionId: null });
  });

  it("fails an atomic file batch when a required headshot revision is missing", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const uploaded = await completeTestDirectUpload(
      testEnv,
      speaker,
      {
        targetType: "person",
        targetId: speaker.personId,
        assetKind: "headshot",
      },
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        "guard-headshot.png",
        { type: "image/png" },
      ),
    );
    const context = {
      organisationId: speaker.organisationId,
      eventId: speaker.eventId,
      assetId: uploaded.assetId,
      headshotFileVersionId: null,
      recordedByPersonId: null,
      correlationId: crypto.randomUUID(),
    };
    await expect(
      testEnv.DB.batch([
        headshotProfileRevisionGuardStatement(testEnv, context),
      ]),
    ).rejects.toThrow();
    await expect(
      testEnv.DB.batch([
        headshotProfileRevisionGuardStatement(testEnv, {
          ...context,
          enabled: false,
        }),
      ]),
    ).resolves.toHaveLength(1);
  });
});
