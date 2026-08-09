import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { loader as speakerFileDownload } from "~/routes/speaker-file-download";
import { loader as speakerResourceDownload } from "~/routes/speaker-resource-download";
import {
  FilePolicyError,
  validateFileDeclaration,
  WORKER_PROXY_UPLOAD_LIMIT_BYTES,
} from "./file-policy";
import {
  FileAccessError,
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
  it("keeps declared uploads below the Worker request-body ceiling", () => {
    const declaredFile = (size: number) =>
      ({ name: "slides.pdf", type: "application/pdf", size }) as File;
    expect(() =>
      validateFileDeclaration(
        "slides",
        declaredFile(WORKER_PROXY_UPLOAD_LIMIT_BYTES),
      ),
    ).not.toThrow();
    expect(() =>
      validateFileDeclaration(
        "slides",
        declaredFile(WORKER_PROXY_UPLOAD_LIMIT_BYTES + 1),
      ),
    ).toThrow("90 MB limit");
  });

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
    const uploaded = await service.uploadParticipantFile(
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
      eventId: speaker.eventId,
      versionId: uploaded.versionId,
      provider: "test-scanner",
      clean: true,
      result: { verdict: "clean" },
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
    const uploaded = await new FileService(testEnv).uploadParticipantFile(
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
          `http://localhost/speaker/files/${uploaded.assetId}`,
        ),
        params: { assetId: uploaded.assetId },
        context: routeContext(),
      } as never),
    ).rejects.toMatchObject({ status: 423 });
    await expect(
      speakerResourceDownload({
        request: new Request(
          "http://localhost/speaker/resources/missing/download",
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
      new FileService(testEnv).uploadParticipantFile(
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
      scanError: "Signature validation failed before quarantine.",
    });
    expect(await env.FILES.head(failed!.objectKey)).toBeNull();
  });

  it("removes a stored R2 object when the metadata commit fails", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    let batchCalls = 0;
    const failingDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            batchCalls += 1;
            if (batchCalls === 2) throw new Error("injected metadata failure");
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failingEnv = new Proxy(testEnv, {
      get(target, property) {
        return property === "DB" ? failingDb : Reflect.get(target, property);
      },
    });
    const file = new File(
      [
        new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
        ]),
      ],
      "metadata-failure.png",
      { type: "image/png" },
    );

    await expect(
      new FileService(failingEnv).uploadParticipantFile(
        speaker,
        {
          targetType: "person",
          targetId: speaker.personId,
          assetKind: "headshot",
        },
        file,
      ),
    ).rejects.toThrow("File metadata commit failed");

    const failed = await testEnv.DB.prepare(
      `SELECT upload_status AS uploadStatus, scan_error AS scanError, object_key AS objectKey
         FROM file_versions WHERE original_filename = ?`,
    )
      .bind(file.name)
      .first<{
        uploadStatus: string;
        scanError: string | null;
        objectKey: string;
      }>();
    expect(failed).toMatchObject({
      uploadStatus: "failed",
      scanError: "Quarantined R2 object removed after metadata commit failure.",
    });
    expect(await testEnv.FILES.head(failed!.objectKey)).toBeNull();
  });

  it("discards an unlinked task upload after evidence submission loses its race", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const taskId = `cleanup-task-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO task_instances (
        id, event_id, target_type, target_id, owner_person_id, title,
        task_type, impact, status, readiness_state, readiness_percent
      ) VALUES (?, ?, 'speaker', ?, ?, 'Cleanup race task',
                'file_upload', 'high', 'not_started', 'on_track', 0)`,
    )
      .bind(taskId, speaker.eventId, speaker.personId, speaker.personId)
      .run();
    const service = new FileService(testEnv);
    const upload = await service.uploadParticipantFile(
      speaker,
      {
        targetType: "task",
        targetId: taskId,
        assetKind: "task_evidence",
      },
      new File(
        [
          new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
          ]),
        ],
        "orphaned-task-evidence.png",
        { type: "image/png" },
      ),
    );
    const stored = await testEnv.DB.prepare(
      "SELECT object_key AS objectKey FROM file_versions WHERE id = ?",
    )
      .bind(upload.versionId)
      .first<{ objectKey: string }>();
    expect(await testEnv.FILES.head(stored!.objectKey)).not.toBeNull();

    await service.discardUnattachedTaskUpload(speaker, upload);

    expect(await testEnv.FILES.head(stored!.objectKey)).toBeNull();
    expect(
      await testEnv.DB.prepare(
        `SELECT fa.status AS assetStatus, fv.upload_status AS uploadStatus,
                fv.scan_status AS scanStatus, fv.deleted_at IS NOT NULL AS deleted
           FROM file_assets fa JOIN file_versions fv ON fv.asset_id = fa.id
          WHERE fa.id = ? AND fv.id = ?`,
      )
        .bind(upload.assetId, upload.versionId)
        .first(),
    ).toEqual({
      assetStatus: "deleted",
      uploadStatus: "failed",
      scanStatus: "failed",
      deleted: 1,
    });
  });

  it("identifies Office uploads from container metadata instead of the filename", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new FileService(testEnv);
    const target = {
      targetType: "person" as const,
      targetId: speaker.personId,
      assetKind: "slides" as const,
    };
    const valid = await service.uploadParticipantFile(
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
      service.uploadParticipantFile(
        speaker,
        target,
        new File([emptyZip(["payload.txt"])], "renamed-archive.pptx", {
          type: pptx,
        }),
      ),
    ).rejects.toBeInstanceOf(FilePolicyError);
    await expect(
      service.uploadParticipantFile(
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
      service.uploadParticipantFile(
        speaker,
        target,
        new File(
          [compoundOfficeFile("WordDocument")],
          "renamed-legacy-document.ppt",
          { type: ppt },
        ),
      ),
    ).rejects.toBeInstanceOf(FilePolicyError);
    const legacy = await service.uploadParticipantFile(
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
      service.uploadParticipantFile(
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
      eventId: speaker.eventId,
      versionId: newer.versionId,
      provider: "test-scanner",
      clean: true,
      result: { verdict: "clean", callback: "first" },
    });
    await service.recordScanResult({
      eventId: speaker.eventId,
      versionId: older.versionId,
      provider: "test-scanner",
      clean: true,
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
    const service = new FileService(testEnv);
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
        service.uploadParticipantFile(
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
    const service = new FileService(testEnv);
    const upload = (name: string) =>
      service.uploadAdminFile(
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
      new FileService(testEnv).uploadParticipantFile(
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
});
