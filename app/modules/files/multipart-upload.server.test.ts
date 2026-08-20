import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  completeTestDirectUpload,
  testFileScanCallbackIdentity,
} from "./direct-upload.test-helper";
import {
  CANONICAL_EVENT_FILE_POLICY,
  FILE_SIZE_MIB,
  FilePolicyError,
} from "./file-policy";
import {
  FileScanDispatchConfigurationError,
  type FileScanQueueMessage,
  processFileScanDispatch,
} from "./file-scan-dispatch.server";
import {
  FileAccessError,
  FileService,
  stableLogicalAssetId,
} from "./file-service.server";
import {
  FileMultipartConflictError,
  FileMultipartIncompleteError,
  FileMultipartStateError,
  MultipartUploadService,
} from "./multipart-upload.server";

const speaker: Viewer = {
  personId: "person-demo-speaker",
  name: "Priya Shah",
  email: "priya.speaker@example.com",
  role: "speaker",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const administrator: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: speaker.organisationId,
  eventId: speaker.eventId,
  demo: true,
};

function configuredMultipartEnvironment() {
  return {
    ...(env as unknown as CloudflareEnvironment),
    DB: env.DB,
    FILES: env.FILES,
    OPERATIONS_QUEUE: { send: async () => undefined },
  } as unknown as CloudflareEnvironment;
}

describe("direct R2 multipart upload", () => {
  beforeEach(async () => {
    await ensureDemoSpeakerData(env as unknown as CloudflareEnvironment);
    await env.DB.prepare(
      `UPDATE task_instances
          SET status = 'not_started', evidence_json = NULL,
              submitted_at = NULL, completed_at = NULL,
              completed_by_person_id = NULL
        WHERE id = 'task-demo-slides' AND event_id = ?`,
    )
      .bind(speaker.eventId)
      .run();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await env.DB.prepare("UPDATE events SET file_policy_json = ? WHERE id = ?")
      .bind(JSON.stringify(CANONICAL_EVENT_FILE_POLICY), speaker.eventId)
      .run();
  });

  it("rejects missing scan dispatch configuration before allocating an upload intent", async () => {
    const idempotencyKey = crypto.randomUUID();
    const unconfigured = {
      ...(env as unknown as CloudflareEnvironment),
      DB: env.DB,
      FILES: env.FILES,
      OPERATIONS_QUEUE: undefined,
    } as unknown as CloudflareEnvironment;
    await expect(
      new MultipartUploadService(unconfigured).initiate(speaker, {
        target: {
          targetType: "task",
          targetId: "task-demo-slides",
          assetKind: "task_evidence",
        },
        filename: "scanner-preflight.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        idempotencyKey,
      }),
    ).rejects.toBeInstanceOf(FileScanDispatchConfigurationError);
    await expect(
      env.DB.prepare(
        "SELECT 1 FROM file_multipart_uploads WHERE idempotency_key = ?",
      )
        .bind(`${speaker.personId}:${idempotencyKey}`)
        .first(),
    ).resolves.toBeNull();
  });

  it("allocates a new generation when retention removed the erased asset but kept its audit tombstone", async () => {
    const target = {
      targetType: "person" as const,
      targetId: speaker.personId,
      assetKind: "headshot" as const,
    };
    const erasedAssetId = await stableLogicalAssetId(speaker, target);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_id, action, entity_type, entity_id, metadata_json, created_at
         ) VALUES (?, 'system', 'internal', 1, ?, ?, 'retention-test',
                   'file.erasure.requested', 'file_asset', ?, '{}', unixepoch())`,
      ).bind(
        `file-erasure:${erasedAssetId}`,
        speaker.organisationId,
        speaker.eventId,
        erasedAssetId,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_id, action, entity_type, entity_id, metadata_json, created_at
         ) VALUES (?, 'system', 'internal', 1, 'another-organisation', ?,
                   'retention-test', 'file.erasure.requested', 'file_asset',
                   ?, '{}', unixepoch())`,
      ).bind(
        `file-erasure:${erasedAssetId}-generation-99`,
        speaker.eventId,
        `${erasedAssetId}-generation-99`,
      ),
    ]);

    const initiated = await new MultipartUploadService(
      configuredMultipartEnvironment(),
    ).initiate(speaker, {
      target,
      filename: "after-retention.png",
      contentType: "image/png",
      sizeBytes: 9,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(initiated.assetId).toBe(`${erasedAssetId}-generation-2`);
    await expect(
      env.DB.prepare(
        `SELECT asset_id AS assetId, version_number AS versionNumber
           FROM file_versions WHERE id = ? AND event_id = ?`,
      )
        .bind(initiated.versionId, speaker.eventId)
        .first(),
    ).resolves.toEqual({
      assetId: initiated.assetId,
      versionNumber: 1,
    });
  });

  it("persists idempotent intent before issuing signed part URLs and supports abort", async () => {
    const service = new MultipartUploadService(
      configuredMultipartEnvironment(),
    );
    const idempotencyKey = crypto.randomUUID();
    const input = {
      target: {
        targetType: "task" as const,
        targetId: "task-demo-slides",
        assetKind: "task_evidence" as const,
      },
      filename: "pitch.pdf",
      contentType: "application/pdf",
      sizeBytes: 90 * 1_048_576 + 1,
      idempotencyKey,
    };
    const initiated = await service.initiate(speaker, input);
    expect(initiated.partSizeBytes).toBe(10 * 1_048_576);
    expect(initiated.partCount).toBe(10);
    expect(initiated.duplicate).toBe(false);
    await expect(service.initiate(speaker, input)).resolves.toMatchObject({
      versionId: initiated.versionId,
      duplicate: true,
    });
    await expect(
      service.initiate(speaker, { ...input, filename: "different.pdf" }),
    ).rejects.toBeInstanceOf(FileMultipartConflictError);

    const part = await service.createPartUrl(speaker, {
      versionId: initiated.versionId,
      partNumber: 1,
    });
    const url = new URL(part.url);
    expect(url.searchParams.get("partNumber")).toBe("1");
    expect(url.searchParams.get("uploadId")).toBeTruthy();
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);

    await expect(
      service.createPartUrl(speaker, {
        versionId: initiated.versionId,
        partNumber: 11,
      }),
    ).rejects.toThrow("between 1 and 10");
    await expect(
      service.abort(speaker, { versionId: initiated.versionId }),
    ).resolves.toEqual({ versionId: initiated.versionId, aborted: true });
    await expect(
      service.abort(speaker, { versionId: initiated.versionId }),
    ).resolves.toEqual({ versionId: initiated.versionId, aborted: true });
    const row = await env.DB.prepare(
      `SELECT upload.status, version.upload_status AS uploadStatus
         FROM file_multipart_uploads upload
         JOIN file_versions version ON version.id = upload.version_id
        WHERE upload.version_id = ?`,
    )
      .bind(initiated.versionId)
      .first<{ status: string; uploadStatus: string }>();
    expect(row).toEqual({ status: "aborted", uploadStatus: "aborted" });
  });

  it("keeps an organiser-owned pending headshot upload under the initiating organiser's control", async () => {
    const service = new MultipartUploadService(
      configuredMultipartEnvironment(),
    );
    const initiated = await service.initiate(administrator, {
      target: {
        targetType: "person",
        targetId: speaker.personId,
        assetKind: "headshot",
      },
      filename: "organiser-headshot.png",
      contentType: "image/png",
      sizeBytes: 9,
      idempotencyKey: crypto.randomUUID(),
    });

    await expect(
      service.createPartUrl(speaker, {
        versionId: initiated.versionId,
        partNumber: 1,
      }),
    ).rejects.toBeInstanceOf(FileAccessError);
    await expect(
      service.abort(speaker, { versionId: initiated.versionId }),
    ).rejects.toBeInstanceOf(FileAccessError);
    await expect(
      service.abort(administrator, { versionId: initiated.versionId }),
    ).resolves.toEqual({ versionId: initiated.versionId, aborted: true });
  });

  it("finishes an abort retry when R2 proves the earlier abort already committed", async () => {
    const baseEnvironment = configuredMultipartEnvironment();
    let abortAttempts = 0;
    const bucket = new Proxy(baseEnvironment.FILES, {
      get(target, property) {
        if (property === "resumeMultipartUpload") {
          return (key: string, uploadId: string) => {
            const multipart = target.resumeMultipartUpload(key, uploadId);
            return new Proxy(multipart, {
              get(multipartTarget, multipartProperty) {
                if (multipartProperty === "abort") {
                  return async () => {
                    abortAttempts += 1;
                    if (abortAttempts === 1) {
                      await multipartTarget.abort();
                      throw new Error("R2 abort response was lost");
                    }
                    throw Object.assign(new Error("NoSuchUpload"), {
                      code: 10024,
                    });
                  };
                }
                const value = Reflect.get(multipartTarget, multipartProperty);
                return typeof value === "function"
                  ? value.bind(multipartTarget)
                  : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const testEnvironment = {
      ...baseEnvironment,
      FILES: bucket,
    } as unknown as CloudflareEnvironment;
    const service = new MultipartUploadService(testEnvironment);
    const initiated = await service.initiate(speaker, {
      target: {
        targetType: "task",
        targetId: "task-demo-slides",
        assetKind: "task_evidence",
      },
      filename: "ambiguous-abort.pdf",
      contentType: "application/pdf",
      sizeBytes: 1,
      idempotencyKey: crypto.randomUUID(),
    });

    await expect(
      service.abort(speaker, { versionId: initiated.versionId }),
    ).rejects.toBeInstanceOf(FileMultipartIncompleteError);
    await expect(
      service.abort(speaker, { versionId: initiated.versionId }),
    ).resolves.toEqual({ versionId: initiated.versionId, aborted: true });
    expect(abortAttempts).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT status, last_error AS lastError FROM file_multipart_uploads WHERE version_id = ?",
      )
        .bind(initiated.versionId)
        .first(),
    ).toEqual({ status: "aborted", lastError: null });
  });

  it("resolves the required event policy at initiation and again at completion", async () => {
    const service = new MultipartUploadService(
      configuredMultipartEnvironment(),
    );
    const rejectedIdempotencyKey = crypto.randomUUID();
    await env.DB.prepare("UPDATE events SET file_policy_json = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          ...CANONICAL_EVENT_FILE_POLICY,
          supportingDocumentMaximumBytes: FILE_SIZE_MIB,
        }),
        speaker.eventId,
      )
      .run();
    await expect(
      service.initiate(speaker, {
        target: {
          targetType: "task",
          targetId: "task-demo-slides",
          assetKind: "task_evidence",
        },
        filename: "over-event-limit.pdf",
        contentType: "application/pdf",
        sizeBytes: FILE_SIZE_MIB + 1,
        idempotencyKey: rejectedIdempotencyKey,
      }),
    ).rejects.toBeInstanceOf(FilePolicyError);
    await expect(
      env.DB.prepare(
        "SELECT 1 FROM file_multipart_uploads WHERE idempotency_key = ?",
      )
        .bind(`${speaker.personId}:${rejectedIdempotencyKey}`)
        .first(),
    ).resolves.toBeNull();

    await env.DB.prepare("UPDATE events SET file_policy_json = ? WHERE id = ?")
      .bind(JSON.stringify(CANONICAL_EVENT_FILE_POLICY), speaker.eventId)
      .run();
    const sizeBytes = FILE_SIZE_MIB + 1;
    const initiated = await service.initiate(speaker, {
      target: {
        targetType: "task",
        targetId: "task-demo-slides",
        assetKind: "task_evidence",
      },
      filename: "policy-change.pdf",
      contentType: "application/pdf",
      sizeBytes,
      idempotencyKey: crypto.randomUUID(),
    });
    const stored = await env.DB.prepare(
      `SELECT object_key AS objectKey, multipart_upload_id AS uploadId
         FROM file_versions WHERE id = ? AND event_id = ?`,
    )
      .bind(initiated.versionId, speaker.eventId)
      .first<{ objectKey: string; uploadId: string }>();
    const bytes = new Uint8Array(sizeBytes);
    bytes.set(new TextEncoder().encode("pending-policy-check"));
    const part = await env.FILES.resumeMultipartUpload(
      stored!.objectKey,
      stored!.uploadId,
    ).uploadPart(1, bytes);
    await env.DB.prepare("UPDATE events SET file_policy_json = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          ...CANONICAL_EVENT_FILE_POLICY,
          supportingDocumentMaximumBytes: FILE_SIZE_MIB,
        }),
        speaker.eventId,
      )
      .run();
    await expect(
      service.createPartUrl(speaker, {
        versionId: initiated.versionId,
        partNumber: 1,
      }),
    ).rejects.toBeInstanceOf(FilePolicyError);
    await expect(
      service.listParts(speaker, { versionId: initiated.versionId }),
    ).rejects.toBeInstanceOf(FilePolicyError);
    await expect(
      service.complete(speaker, {
        versionId: initiated.versionId,
        parts: [{ partNumber: 1, etag: part.etag }],
      }),
    ).rejects.toBeInstanceOf(FilePolicyError);
    await expect(env.FILES.head(stored!.objectKey)).resolves.toBeNull();
    await expect(
      env.DB.prepare(
        "SELECT status FROM file_multipart_uploads WHERE version_id = ?",
      )
        .bind(initiated.versionId)
        .first(),
    ).resolves.toEqual({ status: "initiated" });
    await service.abort(speaker, { versionId: initiated.versionId });
  });

  it("recovers an exact durable upload from a client resume hint", async () => {
    const service = new MultipartUploadService(
      configuredMultipartEnvironment(),
    );
    const idempotencyKey = crypto.randomUUID();
    const input = {
      target: {
        targetType: "task" as const,
        targetId: "task-demo-slides",
        assetKind: "task_evidence" as const,
      },
      filename: "recoverable.pdf",
      contentType: "application/pdf",
      sizeBytes: 12 * 1_048_576,
      idempotencyKey,
    };
    await expect(service.resume(speaker, input)).resolves.toBeNull();
    const initiated = await service.initiate(speaker, input);
    await expect(service.resume(speaker, input)).resolves.toMatchObject({
      versionId: initiated.versionId,
      state: "initiated",
      duplicate: true,
    });
    await expect(
      service.resume(speaker, { ...input, sizeBytes: input.sizeBytes + 1 }),
    ).rejects.toBeInstanceOf(FileMultipartConflictError);
    await service.abort(speaker, { versionId: initiated.versionId });
  });

  it("lists and validates the parts already committed to R2", async () => {
    let requestedUrl = "";
    let requestedSignal: AbortSignal | null = null;
    const service = new MultipartUploadService(
      configuredMultipartEnvironment(),
      {
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          requestedUrl = String(input);
          requestedSignal = init?.signal ?? null;
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?>
             <ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
               <IsTruncated>false</IsTruncated>
               <Part><PartNumber>1</PartNumber><ETag>&quot;etag-one&quot;</ETag><Size>10485760</Size></Part>
               <Part><PartNumber>2</PartNumber><ETag>&quot;etag-two&quot;</ETag><Size>2097152</Size></Part>
             </ListPartsResult>`,
            { status: 200, headers: { "content-type": "application/xml" } },
          );
        }) as typeof fetch,
      },
    );
    const initiated = await service.initiate(speaker, {
      target: {
        targetType: "task",
        targetId: "task-demo-slides",
        assetKind: "task_evidence",
      },
      filename: "resume-parts.pdf",
      contentType: "application/pdf",
      sizeBytes: 12 * 1_048_576,
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(
      service.listParts(speaker, { versionId: initiated.versionId }),
    ).resolves.toMatchObject({
      versionId: initiated.versionId,
      state: "initiated",
      parts: [
        { PartNumber: 1, Size: 10 * 1_048_576, ETag: '"etag-one"' },
        { PartNumber: 2, Size: 2 * 1_048_576, ETag: '"etag-two"' },
      ],
    });
    expect(new URL(requestedUrl).searchParams.get("uploadId")).toBeTruthy();
    expect(new URL(requestedUrl).searchParams.get("max-parts")).toBe("2");
    expect(requestedSignal).toBeInstanceOf(AbortSignal);
    expect((requestedSignal as AbortSignal | null)?.aborted).toBe(false);
    await service.abort(speaker, { versionId: initiated.versionId });
  });

  it("rejects provider part metadata that cannot belong to the declaration", async () => {
    const service = new MultipartUploadService(
      configuredMultipartEnvironment(),
      {
        fetch: (async () =>
          new Response(
            `<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>1</PartNumber><ETag>etag</ETag><Size>1</Size></Part></ListPartsResult>`,
            { status: 200 },
          )) as typeof fetch,
      },
    );
    const initiated = await service.initiate(speaker, {
      target: {
        targetType: "task",
        targetId: "task-demo-slides",
        assetKind: "task_evidence",
      },
      filename: "wrong-part-size.pdf",
      contentType: "application/pdf",
      sizeBytes: 12 * 1_048_576,
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(
      service.listParts(speaker, { versionId: initiated.versionId }),
    ).rejects.toThrow("does not match the declared upload chunk size");
    await service.abort(speaker, { versionId: initiated.versionId });
  });

  it("rejects an oversized R2 part listing without buffering its body", async () => {
    const service = new MultipartUploadService(
      configuredMultipartEnvironment(),
      {
        fetch: (async () =>
          new Response("not-read", {
            status: 200,
            headers: { "content-length": "2000001" },
          })) as typeof fetch,
      },
    );
    const initiated = await service.initiate(speaker, {
      target: {
        targetType: "task",
        targetId: "task-demo-slides",
        assetKind: "task_evidence",
      },
      filename: "oversized-list.pdf",
      contentType: "application/pdf",
      sizeBytes: 1,
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(
      service.listParts(speaker, { versionId: initiated.versionId }),
    ).rejects.toThrow("unexpectedly large multipart part list");
    await service.abort(speaker, { versionId: initiated.versionId });
  });

  it("uses signed direct upload for a valid file of any positive size", async () => {
    const service = new MultipartUploadService(
      configuredMultipartEnvironment(),
    );
    const initiated = await service.initiate(speaker, {
      target: {
        targetType: "task",
        targetId: "task-demo-slides",
        assetKind: "task_evidence",
      },
      filename: "small.pdf",
      contentType: "application/pdf",
      sizeBytes: 1,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(initiated).toMatchObject({ partCount: 1, duplicate: false });
    await expect(
      service.abort(speaker, { versionId: initiated.versionId }),
    ).resolves.toMatchObject({ aborted: true });
  });

  it("uses the video limit for video task evidence through completion", async () => {
    const testEnvironment = configuredMultipartEnvironment();
    const policy = {
      ...CANONICAL_EVENT_FILE_POLICY,
      supportingDocumentMaximumBytes: FILE_SIZE_MIB,
      videoMaximumBytes: 2 * FILE_SIZE_MIB,
    };
    await testEnvironment.DB.prepare(
      "UPDATE events SET file_policy_json = ? WHERE id = ?",
    )
      .bind(JSON.stringify(policy), speaker.eventId)
      .run();
    const service = new MultipartUploadService(testEnvironment);
    await expect(
      service.initiate(speaker, {
        target: {
          targetType: "task",
          targetId: "task-demo-slides",
          assetKind: "task_evidence",
        },
        filename: "oversized-handout.pdf",
        contentType: "application/pdf",
        sizeBytes: FILE_SIZE_MIB + 1,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("1 MB event limit");

    const participantDocumentTaskId = `participant-document-${crypto.randomUUID()}`;
    await testEnvironment.DB.prepare(
      `INSERT INTO task_instances (
         id, event_id, target_type, target_id, owner_person_id, title,
         task_type, impact, evidence_mode, configuration_json, status,
         readiness_state, readiness_percent
       ) VALUES (?, ?, 'speaker', ?, ?, 'Upload participant document',
                 'file_upload', 'high', 'file',
                 '{"fileScope":"participant_document"}', 'not_started',
                 'on_track', 0)`,
    )
      .bind(
        participantDocumentTaskId,
        speaker.eventId,
        speaker.personId,
        speaker.personId,
      )
      .run();
    await expect(
      service.initiate(speaker, {
        target: {
          targetType: "task",
          targetId: participantDocumentTaskId,
          assetKind: "task_evidence",
        },
        filename: "participant-recording.mp4",
        contentType: "video/mp4",
        sizeBytes: FILE_SIZE_MIB + 1,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("1 MB event limit");

    const bytes = new Uint8Array(FILE_SIZE_MIB + 1);
    bytes.set([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const initiated = await service.initiate(speaker, {
      target: {
        targetType: "task",
        targetId: "task-demo-slides",
        assetKind: "task_evidence",
      },
      filename: "session-recording.mp4",
      contentType: "video/mp4",
      sizeBytes: bytes.byteLength,
      idempotencyKey: crypto.randomUUID(),
    });
    const stored = await testEnvironment.DB.prepare(
      `SELECT object_key AS objectKey, multipart_upload_id AS uploadId
         FROM file_versions WHERE id = ? AND event_id = ?`,
    )
      .bind(initiated.versionId, speaker.eventId)
      .first<{ objectKey: string; uploadId: string }>();
    if (!stored) throw new Error("Multipart video intent was not persisted.");
    const part = await testEnvironment.FILES.resumeMultipartUpload(
      stored.objectKey,
      stored.uploadId,
    ).uploadPart(1, bytes);

    await expect(
      service.complete(speaker, {
        versionId: initiated.versionId,
        parts: [{ partNumber: 1, etag: part.etag }],
      }),
    ).resolves.toMatchObject({
      assetId: initiated.assetId,
      versionId: initiated.versionId,
      scanStatus: "pending",
    });
  });

  it("rejects ineligible task evidence before allocating upload metadata", async () => {
    const testEnvironment = configuredMultipartEnvironment();
    const prefix = `multipart-task-preflight-${crypto.randomUUID()}`;
    const prerequisiteId = `${prefix}-prerequisite`;
    const blockedId = `${prefix}-blocked`;
    const submittedId = `${prefix}-submitted`;
    const checklistId = `${prefix}-checklist`;
    const wrongKindId = `${prefix}-wrong-kind`;
    await testEnvironment.DB.batch([
      ...[
        [prerequisiteId, "checklist", "not_started"],
        [blockedId, "file_upload", "not_started"],
        [submittedId, "file_upload", "submitted"],
        [checklistId, "checklist", "not_started"],
        [wrongKindId, "file_upload", "not_started"],
      ].map(([id, taskType, status]) =>
        testEnvironment.DB.prepare(
          `INSERT INTO task_instances (
             id, event_id, target_type, target_id, owner_person_id, title,
             task_type, impact, status, readiness_state, readiness_percent
           ) VALUES (?, ?, 'speaker', ?, ?, 'Multipart preflight', ?, 'high', ?, 'on_track', 0)`,
        ).bind(
          id,
          speaker.eventId,
          speaker.personId,
          speaker.personId,
          taskType,
          status,
        ),
      ),
      testEnvironment.DB.prepare(
        `INSERT INTO task_instance_dependencies (task_id, depends_on_task_id)
         VALUES (?, ?)`,
      ).bind(blockedId, prerequisiteId),
    ]);

    const service = new MultipartUploadService(testEnvironment);
    const attempts = [
      { taskId: blockedId, assetKind: "task_evidence" },
      { taskId: submittedId, assetKind: "task_evidence" },
      { taskId: checklistId, assetKind: "task_evidence" },
      { taskId: wrongKindId, assetKind: "supporting_document" },
    ] as const;
    for (const attempt of attempts) {
      await expect(
        service.initiate(speaker, {
          target: {
            targetType: "task",
            targetId: attempt.taskId,
            assetKind: attempt.assetKind,
          },
          filename: "evidence.pdf",
          contentType: "application/pdf",
          sizeBytes: 1,
          idempotencyKey: crypto.randomUUID(),
        }),
      ).rejects.toBeInstanceOf(FileAccessError);
    }
    expect(
      await testEnvironment.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM file_assets
             WHERE target_id IN (?, ?, ?, ?)) AS assetCount,
           (SELECT COUNT(*)
              FROM file_multipart_uploads upload
              JOIN file_assets asset
                ON asset.id = upload.asset_id AND asset.event_id = upload.event_id
             WHERE asset.target_id IN (?, ?, ?, ?)) AS intentCount`,
      )
        .bind(
          blockedId,
          submittedId,
          checklistId,
          wrongKindId,
          blockedId,
          submittedId,
          checklistId,
          wrongKindId,
        )
        .first<{ assetCount: number; intentCount: number }>(),
    ).toEqual({ assetCount: 0, intentCount: 0 });
  });

  it("stops an in-flight task upload when the task is no longer eligible", async () => {
    const testEnvironment = configuredMultipartEnvironment();
    const taskId = `multipart-task-race-${crypto.randomUUID()}`;
    await testEnvironment.DB.prepare(
      `INSERT INTO task_instances (
         id, event_id, target_type, target_id, owner_person_id, title,
         task_type, impact, status, readiness_state, readiness_percent,
         configuration_json
       ) VALUES (?, ?, 'speaker', ?, ?, 'Multipart race', 'file_upload',
                 'high', 'not_started', 'on_track', 0,
                 '{"fileScope":"participant_document"}')`,
    )
      .bind(taskId, speaker.eventId, speaker.personId, speaker.personId)
      .run();
    const service = new MultipartUploadService(testEnvironment);
    const initiated = await service.initiate(speaker, {
      target: {
        targetType: "task",
        targetId: taskId,
        assetKind: "task_evidence",
      },
      filename: "evidence.pdf",
      contentType: "application/pdf",
      sizeBytes: 1,
      idempotencyKey: crypto.randomUUID(),
    });

    await testEnvironment.DB.prepare(
      `UPDATE task_instances SET status = 'submitted' WHERE id = ? AND event_id = ?`,
    )
      .bind(taskId, speaker.eventId)
      .run();

    await expect(
      service.createPartUrl(speaker, {
        versionId: initiated.versionId,
        partNumber: 1,
      }),
    ).rejects.toBeInstanceOf(FileAccessError);
    await expect(
      service.listParts(speaker, { versionId: initiated.versionId }),
    ).rejects.toBeInstanceOf(FileAccessError);
    await expect(
      service.complete(speaker, {
        versionId: initiated.versionId,
        parts: [{ partNumber: 1, etag: "unused-etag" }],
      }),
    ).rejects.toBeInstanceOf(FileAccessError);
    await expect(
      service.abort(speaker, { versionId: initiated.versionId }),
    ).resolves.toEqual({ versionId: initiated.versionId, aborted: true });
  });

  it("denies every multipart continuation after a named session owner leaves the session", async () => {
    const testEnvironment = configuredMultipartEnvironment();
    await testEnvironment.DB.prepare(
      `UPDATE task_instances SET owner_person_id = ?
        WHERE id = 'task-demo-slides' AND event_id = ?`,
    )
      .bind(speaker.personId, speaker.eventId)
      .run();
    const service = new MultipartUploadService(testEnvironment);
    const input = {
      target: {
        targetType: "task" as const,
        targetId: "task-demo-slides",
        assetKind: "task_evidence" as const,
      },
      filename: "revoked-session-owner.pdf",
      contentType: "application/pdf",
      sizeBytes: 1,
      idempotencyKey: crypto.randomUUID(),
    };
    const initiated = await service.initiate(speaker, input);

    await testEnvironment.DB.prepare(
      `DELETE FROM session_speakers
        WHERE event_id = ? AND session_id = 'session-demo-speaker'
          AND person_id = ?`,
    )
      .bind(speaker.eventId, speaker.personId)
      .run();

    await expect(service.resume(speaker, input)).rejects.toBeInstanceOf(
      FileAccessError,
    );
    await expect(
      service.createPartUrl(speaker, {
        versionId: initiated.versionId,
        partNumber: 1,
      }),
    ).rejects.toBeInstanceOf(FileAccessError);
    await expect(
      service.listParts(speaker, { versionId: initiated.versionId }),
    ).rejects.toBeInstanceOf(FileAccessError);
    await expect(
      service.complete(speaker, {
        versionId: initiated.versionId,
        parts: [{ partNumber: 1, etag: "unused-etag" }],
      }),
    ).rejects.toBeInstanceOf(FileAccessError);
    await expect(
      service.abort(speaker, { versionId: initiated.versionId }),
    ).resolves.toEqual({ versionId: initiated.versionId, aborted: true });
  });

  it("does not allocate a replacement version after session access is revoked", async () => {
    const baseEnvironment = configuredMultipartEnvironment();
    const initial = await new MultipartUploadService(baseEnvironment).initiate(
      speaker,
      {
        target: {
          targetType: "task",
          targetId: "task-demo-slides",
          assetKind: "task_evidence",
        },
        filename: "initial-session-deck.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    await baseEnvironment.DB.batch([
      baseEnvironment.DB.prepare(
        `UPDATE task_instances
            SET status = 'submitted', evidence_json = ?, submitted_at = unixepoch()
          WHERE id = 'task-demo-slides' AND event_id = ?`,
      ).bind(
        JSON.stringify({
          fileAssetId: initial.assetId,
          fileVersionId: initial.versionId,
          scanStatus: "pending",
        }),
        speaker.eventId,
      ),
      baseEnvironment.DB.prepare(
        `INSERT INTO task_evidence (
           id, event_id, task_id, submitted_by_person_id, file_asset_id,
           evidence_json, status, created_at
         ) VALUES (?, ?, 'task-demo-slides', ?, ?, ?, 'submitted', unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        speaker.eventId,
        speaker.personId,
        initial.assetId,
        JSON.stringify({
          fileVersionId: initial.versionId,
          scanStatus: "pending",
        }),
      ),
    ]);

    let relationshipRevoked = false;
    const racingDb = new Proxy(baseEnvironment.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!relationshipRevoked) {
              relationshipRevoked = true;
              await target
                .prepare(
                  `DELETE FROM session_speakers
                    WHERE event_id = ? AND session_id = 'session-demo-speaker'
                      AND person_id = ?`,
                )
                .bind(speaker.eventId, speaker.personId)
                .run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const racingEnvironment = new Proxy(baseEnvironment, {
      get(target, property) {
        return property === "DB" ? racingDb : Reflect.get(target, property);
      },
    });

    await expect(
      new MultipartUploadService(racingEnvironment).initiate(speaker, {
        target: {
          targetType: "task",
          targetId: "task-demo-slides",
          assetKind: "task_evidence",
        },
        filename: "replacement-session-deck.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow(
      "The multipart file version could not be allocated atomically.",
    );
    expect(relationshipRevoked).toBe(true);
    await expect(
      baseEnvironment.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM file_versions
             WHERE asset_id = ?) AS versionCount,
           (SELECT COUNT(*) FROM file_multipart_uploads
             WHERE asset_id = ?) AS intentCount`,
      )
        .bind(initial.assetId, initial.assetId)
        .first(),
    ).resolves.toEqual({ versionCount: 1, intentCount: 1 });
  });

  it("revokes a completing upload when its target becomes ineligible", async () => {
    const baseEnvironment = configuredMultipartEnvironment();
    let failFirstCompletion = true;
    let providerAbortCount = 0;
    const bucket = new Proxy(baseEnvironment.FILES, {
      get(target, property) {
        if (property === "resumeMultipartUpload") {
          return (key: string, uploadId: string) => {
            const multipart = target.resumeMultipartUpload(key, uploadId);
            return new Proxy(multipart, {
              get(multipartTarget, multipartProperty) {
                if (multipartProperty === "complete" && failFirstCompletion) {
                  return async () => {
                    failFirstCompletion = false;
                    throw new Error("R2 completion response was unavailable");
                  };
                }
                if (multipartProperty === "abort") {
                  return async () => {
                    providerAbortCount += 1;
                    return multipartTarget.abort();
                  };
                }
                const value = Reflect.get(multipartTarget, multipartProperty);
                return typeof value === "function"
                  ? value.bind(multipartTarget)
                  : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const testEnvironment = {
      ...baseEnvironment,
      FILES: bucket,
    } as unknown as CloudflareEnvironment;
    const taskId = `multipart-completing-race-${crypto.randomUUID()}`;
    await testEnvironment.DB.prepare(
      `INSERT INTO task_instances (
         id, event_id, target_type, target_id, owner_person_id, title,
         task_type, impact, status, readiness_state, readiness_percent,
         configuration_json
       ) VALUES (?, ?, 'speaker', ?, ?, 'Multipart completion race', 'file_upload',
                 'high', 'not_started', 'on_track', 0,
                 '{"fileScope":"participant_document"}')`,
    )
      .bind(taskId, speaker.eventId, speaker.personId, speaker.personId)
      .run();
    const service = new MultipartUploadService(testEnvironment);
    const bytes = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
    const initiated = await service.initiate(speaker, {
      target: {
        targetType: "task",
        targetId: taskId,
        assetKind: "task_evidence",
      },
      filename: "evidence.pdf",
      contentType: "application/pdf",
      sizeBytes: bytes.byteLength,
      idempotencyKey: crypto.randomUUID(),
    });
    const stored = await testEnvironment.DB.prepare(
      `SELECT object_key AS objectKey, multipart_upload_id AS uploadId
         FROM file_versions WHERE id = ? AND event_id = ?`,
    )
      .bind(initiated.versionId, speaker.eventId)
      .first<{ objectKey: string; uploadId: string }>();
    const part = await testEnvironment.FILES.resumeMultipartUpload(
      stored!.objectKey,
      stored!.uploadId,
    ).uploadPart(1, bytes);
    const completion = {
      versionId: initiated.versionId,
      parts: [{ partNumber: 1, etag: part.etag }],
    };

    await expect(service.complete(speaker, completion)).rejects.toBeInstanceOf(
      FileMultipartIncompleteError,
    );
    await expect(
      testEnvironment.DB.prepare(
        "SELECT status FROM file_multipart_uploads WHERE version_id = ?",
      )
        .bind(initiated.versionId)
        .first(),
    ).resolves.toEqual({ status: "completing" });
    await testEnvironment.DB.prepare(
      `UPDATE task_instances SET status = 'submitted'
        WHERE id = ? AND event_id = ?`,
    )
      .bind(taskId, speaker.eventId)
      .run();

    await expect(service.complete(speaker, completion)).rejects.toBeInstanceOf(
      FileAccessError,
    );
    expect(providerAbortCount).toBe(1);
    await expect(
      testEnvironment.FILES.head(stored!.objectKey),
    ).resolves.toBeNull();
    await expect(
      testEnvironment.DB.prepare(
        `SELECT upload.status, version.upload_status AS uploadStatus,
                version.signature_status AS signatureStatus,
                version.scan_status AS scanStatus, asset.status AS assetStatus
           FROM file_multipart_uploads upload
           JOIN file_versions version
             ON version.id = upload.version_id AND version.event_id = upload.event_id
           JOIN file_assets asset
             ON asset.id = upload.asset_id AND asset.event_id = upload.event_id
          WHERE upload.version_id = ?`,
      )
        .bind(initiated.versionId)
        .first(),
    ).resolves.toEqual({
      status: "failed",
      uploadStatus: "failed",
      signatureStatus: "invalid",
      scanStatus: "failed",
      assetStatus: "rejected",
    });
  });

  it("aborts R2 and compensates both records when only one metadata update commits", async () => {
    let providerAbortCount = 0;
    let injectedPartialCommit = false;
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            if (!injectedPartialCommit && statements.length === 2) {
              injectedPartialCommit = true;
              return [
                results[0]!,
                {
                  ...results[1]!,
                  meta: { ...results[1]!.meta, changes: 0 },
                },
              ];
            }
            return results;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const bucket = new Proxy(env.FILES, {
      get(target, property) {
        if (property === "createMultipartUpload")
          return async (
            ...args: Parameters<R2Bucket["createMultipartUpload"]>
          ) => {
            const upload = await target.createMultipartUpload(...args);
            return new Proxy(upload, {
              get(uploadTarget, uploadProperty) {
                if (uploadProperty === "abort")
                  return async () => {
                    providerAbortCount += 1;
                    return uploadTarget.abort();
                  };
                const value = Reflect.get(uploadTarget, uploadProperty);
                return typeof value === "function"
                  ? value.bind(uploadTarget)
                  : value;
              },
            });
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const testEnvironment = {
      ...(env as unknown as CloudflareEnvironment),
      DB: database,
      FILES: bucket,
      OPERATIONS_QUEUE: { send: async () => undefined },
    } as unknown as CloudflareEnvironment;
    const idempotencyKey = crypto.randomUUID();
    await expect(
      new MultipartUploadService(testEnvironment).initiate(speaker, {
        target: {
          targetType: "task",
          targetId: "task-demo-slides",
          assetKind: "task_evidence",
        },
        filename: "partial-commit.pdf",
        contentType: "application/pdf",
        sizeBytes: 90 * 1_048_576 + 1,
        idempotencyKey,
      }),
    ).rejects.toBeInstanceOf(FileMultipartIncompleteError);
    expect(providerAbortCount).toBe(1);
    expect(
      await env.DB.prepare(
        `SELECT upload.status, upload.upload_id AS uploadId,
                version.upload_status AS uploadStatus,
                version.multipart_upload_id AS multipartUploadId
           FROM file_multipart_uploads upload
           JOIN file_versions version ON version.id = upload.version_id
          WHERE upload.idempotency_key = ?`,
      )
        .bind(`${speaker.personId}:${idempotencyKey}`)
        .first(),
    ).toEqual({
      status: "failed",
      uploadId: null,
      uploadStatus: "failed",
      multipartUploadId: null,
    });
  });

  it("revokes and aborts an incomplete provider upload during permanent erasure", async () => {
    const testEnvironment = configuredMultipartEnvironment();
    const multipart = new MultipartUploadService(testEnvironment);
    const initiated = await multipart.initiate(speaker, {
      target: {
        targetType: "task",
        targetId: "task-demo-slides",
        assetKind: "task_evidence",
      },
      filename: "erase-incomplete.pdf",
      contentType: "application/pdf",
      sizeBytes: 90 * 1_048_576 + 1,
      idempotencyKey: crypto.randomUUID(),
    });

    await expect(
      new FileService(testEnvironment).eraseAsset(administrator, {
        assetId: initiated.assetId,
        confirmed: true,
      }),
    ).resolves.toMatchObject({ duplicate: false });
    await expect(
      multipart.createPartUrl(speaker, {
        versionId: initiated.versionId,
        partNumber: 1,
      }),
    ).rejects.toBeInstanceOf(FileMultipartStateError);
    expect(
      await env.DB.prepare(
        `SELECT asset.status AS assetStatus, upload.status,
                version.upload_status AS uploadStatus,
                version.deleted_at AS deletedAt
           FROM file_multipart_uploads upload
           JOIN file_versions version ON version.id = upload.version_id
           JOIN file_assets asset ON asset.id = upload.asset_id
          WHERE upload.version_id = ?`,
      )
        .bind(initiated.versionId)
        .first<{
          assetStatus: string;
          status: string;
          uploadStatus: string;
          deletedAt: number | null;
        }>(),
    ).toMatchObject({
      assetStatus: "deleted",
      status: "aborted",
      uploadStatus: "aborted",
      deletedAt: expect.any(Number),
    });
  });

  it("completes erasure when an earlier multipart abort committed but its response was lost", async () => {
    const testEnvironment = configuredMultipartEnvironment();
    const initiated = await new MultipartUploadService(
      testEnvironment,
    ).initiate(speaker, {
      target: {
        targetType: "task",
        targetId: "task-demo-slides",
        assetKind: "task_evidence",
      },
      filename: "erase-after-ambiguous-abort.pdf",
      contentType: "application/pdf",
      sizeBytes: 90 * 1_048_576 + 1,
      idempotencyKey: crypto.randomUUID(),
    });
    const stored = await env.DB.prepare(
      `SELECT version.object_key AS objectKey, upload.upload_id AS uploadId
         FROM file_versions version
         JOIN file_multipart_uploads upload
           ON upload.version_id = version.id AND upload.event_id = version.event_id
        WHERE version.id = ?`,
    )
      .bind(initiated.versionId)
      .first<{ objectKey: string; uploadId: string }>();
    expect(stored).not.toBeNull();

    await env.FILES.resumeMultipartUpload(
      stored!.objectKey,
      stored!.uploadId,
    ).abort();

    await expect(
      new FileService(testEnvironment).eraseAsset(administrator, {
        assetId: initiated.assetId,
        confirmed: true,
      }),
    ).resolves.toMatchObject({ duplicate: false, erasedVersions: 1 });
    await expect(
      env.DB.prepare(
        `SELECT asset.status, version.deleted_at AS deletedAt
           FROM file_assets asset
           JOIN file_versions version
             ON version.asset_id = asset.id AND version.event_id = asset.event_id
          WHERE asset.id = ? AND version.id = ?`,
      )
        .bind(initiated.assetId, initiated.versionId)
        .first(),
    ).resolves.toEqual({
      status: "deleted",
      deletedAt: expect.any(Number),
    });
  });

  it("validates the assembled private object before quarantine and dispatches scanning", async () => {
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      DB: env.DB,
      FILES: env.FILES,
      OPERATIONS_QUEUE: { send: async () => undefined },
    } as unknown as CloudflareEnvironment;
    const service = new MultipartUploadService(testEnv);
    const assetId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const objectKey = `private/test/${versionId}`;
    const bytes = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
    const provider = await env.FILES.createMultipartUpload(objectKey, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: {
        eventId: speaker.eventId,
        assetId,
        versionId,
        quarantine: "pending-scan",
      },
    });
    const part = await provider.uploadPart(1, bytes);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, 'task', 'task-demo-slides', 'task_evidence',
                   'pending', unixepoch(), unixepoch())`,
      ).bind(assetId, speaker.eventId, speaker.personId),
      env.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           multipart_upload_id, original_filename, declared_content_type,
           size_bytes, upload_status, signature_status, scan_status,
           created_by_person_id, created_at
         ) VALUES (?, ?, ?, 1, ?, ?, 'notes.pdf', 'application/pdf', ?,
                   'uploading', 'pending', 'pending', ?, unixepoch())`,
      ).bind(
        versionId,
        speaker.eventId,
        assetId,
        objectKey,
        provider.uploadId,
        bytes.byteLength,
        speaker.personId,
      ),
      env.DB.prepare(
        `INSERT INTO file_multipart_uploads (
           version_id, event_id, asset_id, upload_id, idempotency_key,
           status, part_size_bytes, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'initiated', ?, unixepoch() + 3600,
                   unixepoch(), unixepoch())`,
      ).bind(
        versionId,
        speaker.eventId,
        assetId,
        provider.uploadId,
        `${speaker.personId}:${crypto.randomUUID()}`,
        10 * 1_048_576,
      ),
    ]);

    const completionInput = {
      versionId,
      parts: [{ partNumber: 1, etag: part.etag }],
    };
    const unconfiguredCompletion = new MultipartUploadService({
      ...testEnv,
      OPERATIONS_QUEUE: undefined,
    } as unknown as CloudflareEnvironment);
    await expect(
      unconfiguredCompletion.complete(speaker, completionInput),
    ).rejects.toBeInstanceOf(FileScanDispatchConfigurationError);
    await expect(env.FILES.head(objectKey)).resolves.toBeNull();
    await expect(
      env.DB.prepare(
        `SELECT upload.status, version.upload_status AS uploadStatus
           FROM file_multipart_uploads upload
           JOIN file_versions version ON version.id = upload.version_id
          WHERE upload.version_id = ?`,
      )
        .bind(versionId)
        .first(),
    ).resolves.toEqual({ status: "initiated", uploadStatus: "uploading" });

    const completed = await service.complete(speaker, completionInput);
    expect(completed).toMatchObject({
      assetId,
      versionId,
      scanStatus: "pending",
      duplicate: false,
    });
    await expect(
      service.listParts(speaker, { versionId }),
    ).resolves.toMatchObject({
      state: "completed",
      parts: [{ PartNumber: 1, Size: bytes.byteLength, ETag: part.etag }],
    });
    const row = await env.DB.prepare(
      `SELECT upload.status, version.upload_status AS uploadStatus,
              version.signature_status AS signatureStatus,
              version.scan_status AS scanStatus,
              operation.status AS operationStatus
         FROM file_multipart_uploads upload
         JOIN file_versions version ON version.id = upload.version_id
         JOIN operation_jobs operation
           ON operation.id = 'file-scan-dispatch:' || version.id
        WHERE upload.version_id = ?`,
    )
      .bind(versionId)
      .first<{
        status: string;
        uploadStatus: string;
        signatureStatus: string;
        scanStatus: string;
        operationStatus: string;
      }>();
    expect(row).toEqual({
      status: "completed",
      uploadStatus: "uploaded",
      signatureStatus: "valid",
      scanStatus: "pending",
      operationStatus: "queued",
    });
  });

  it("dispatches and releases a valid headshot retry after rejecting the first upload", async () => {
    const suffix = crypto.randomUUID();
    const retryingSpeaker: Viewer = {
      ...speaker,
      personId: `person-headshot-retry-${suffix}`,
      email: `headshot-retry-${suffix}@example.com`,
    };
    await env.DB.prepare(
      `INSERT INTO people (id, email, display_name, email_verified)
       VALUES (?, ?, 'Headshot retry speaker', 1)`,
    )
      .bind(retryingSpeaker.personId, retryingSpeaker.email)
      .run();

    const testEnvironment = configuredMultipartEnvironment();
    const target = {
      targetType: "person" as const,
      targetId: retryingSpeaker.personId,
      assetKind: "headshot" as const,
    };
    await expect(
      completeTestDirectUpload(
        testEnvironment,
        retryingSpeaker,
        target,
        new File(["not a png"], "invalid.png", { type: "image/png" }),
      ),
    ).rejects.toThrow();

    const valid = await completeTestDirectUpload(
      testEnvironment,
      retryingSpeaker,
      target,
      new File(
        [
          new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
          ]),
        ],
        "valid.png",
        { type: "image/png" },
      ),
    );
    await expect(
      env.DB.prepare("SELECT status FROM file_assets WHERE id = ?")
        .bind(valid.assetId)
        .first(),
    ).resolves.toEqual({ status: "pending" });

    const operation = await env.DB.prepare(
      "SELECT payload_json AS payloadJson FROM operation_jobs WHERE id = ?",
    )
      .bind(`file-scan-dispatch:${valid.versionId}`)
      .first<{ payloadJson: string }>();
    expect(operation).not.toBeNull();
    const scanner = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", scanner);
    await expect(
      processFileScanDispatch(
        JSON.parse(operation!.payloadJson) as FileScanQueueMessage,
        testEnvironment,
      ),
    ).resolves.toEqual({ duplicate: false, awaitingCallback: true });
    expect(scanner).toHaveBeenCalledTimes(1);

    const callback = await testFileScanCallbackIdentity(
      testEnvironment,
      retryingSpeaker.eventId,
      valid.versionId,
    );
    await new FileService(testEnvironment).recordScanResult({
      ...callback,
      eventId: retryingSpeaker.eventId,
      versionId: valid.versionId,
      provider: "test-scanner",
      callbackId: `callback-${valid.versionId}`,
      status: "clean",
      result: { verdict: "clean" },
    });
    await expect(
      env.DB.prepare(
        `SELECT asset.status AS assetStatus,
                asset.current_version_id AS currentVersionId,
                version.scan_status AS scanStatus,
                operation.status AS operationStatus
           FROM file_assets asset
           JOIN file_versions version
             ON version.id = ? AND version.asset_id = asset.id
           JOIN operation_jobs operation
             ON operation.id = 'file-scan-dispatch:' || version.id`,
      )
        .bind(valid.versionId)
        .first(),
    ).resolves.toEqual({
      assetStatus: "active",
      currentVersionId: valid.versionId,
      scanStatus: "clean",
      operationStatus: "completed",
    });
  });
});
