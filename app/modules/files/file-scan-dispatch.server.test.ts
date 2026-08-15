import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { ResponseBodyTooLargeError } from "~/platform/http/read-response";
import { QueueClaimLeaseBusyError } from "../../../workers/queue/claim-infrastructure";
import {
  assertFileScanDispatchConfigured,
  FileScanDispatchConfigurationError,
  FileScanDispatchIntegrityError,
  processFileScanDispatch,
  type FileScanQueueMessage,
} from "./file-scan-dispatch.server";
import { FileService } from "./file-service.server";

async function dispatchSignatureIsValid(init: RequestInit | undefined) {
  const headers = new Headers(init?.headers);
  const timestamp = headers.get("x-program-cue-dispatch-timestamp");
  const signature = headers.get("x-program-cue-dispatch-signature");
  if (!timestamp || !signature?.startsWith("v1,") || !init?.body) return false;
  const supplied = Uint8Array.from(atob(signature.slice(3)), (character) =>
    character.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      (env as unknown as CloudflareEnvironment).FILE_SCANNER_DISPATCH_SECRET,
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    supplied,
    new TextEncoder().encode(`${timestamp}.${String(init.body)}`),
  );
}

async function persistQueuedScan(message: FileScanQueueMessage) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO file_assets (
         id, event_id, owner_person_id, target_type, target_id, asset_kind,
         status, created_at, updated_at
       ) VALUES (?, ?, NULL, 'resource',
                 ?, 'resource_attachment', 'pending',
                 unixepoch(), unixepoch())`,
    ).bind(message.assetId, message.eventId, message.assetId),
    env.DB.prepare(
      `INSERT INTO file_versions (
         id, event_id, asset_id, version_number, object_key,
         multipart_upload_id, original_filename, declared_content_type,
         detected_content_type, size_bytes, object_etag, upload_status,
         signature_status, scan_status, created_by_person_id, uploaded_at,
         created_at
       ) VALUES (?, ?, ?, 1, ?, ?, 'scan.pdf', 'application/pdf',
                 'application/pdf', ?, ?, 'uploaded', 'valid', 'pending',
                 'person-demo-speaker', unixepoch(), unixepoch())`,
    ).bind(
      message.versionId,
      message.eventId,
      message.assetId,
      message.objectKey,
      `upload-${message.versionId}`,
      message.sizeBytes,
      message.objectEtag,
    ),
    env.DB.prepare(
      `INSERT INTO file_multipart_uploads (
         version_id, event_id, asset_id, upload_id, idempotency_key,
         status, part_size_bytes, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'completed', 10485760,
                 unixepoch() + 3600, unixepoch(), unixepoch())`,
    ).bind(
      message.versionId,
      message.eventId,
      message.assetId,
      `upload-${message.versionId}`,
      `multipart:${message.versionId}`,
    ),
    env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         progress_total, progress_completed, progress_failed, cancellable,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'person-demo-speaker', 'file.scan.dispatch', ?, ?,
                 'queued', ?, 1, 0, 0, 0, unixepoch(), unixepoch())`,
    ).bind(
      message.operationId,
      message.organisationId,
      message.eventId,
      message.idempotencyKey,
      message.operationId,
      JSON.stringify(message),
    ),
  ]);
}

describe("file scan queue dispatch", () => {
  beforeEach(async () => {
    await ensureDemoSpeakerData(env as unknown as CloudflareEnvironment);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [
      "scanner endpoint",
      { FILE_SCANNER_API_URL: undefined },
      "scanner-endpoint",
    ],
    [
      "scanner credentials",
      {
        FILE_SCANNER_API_URL: "https://scanner.programcue.test",
        FILE_SCANNER_DISPATCH_SECRET: undefined,
      },
      "scanner-credentials",
    ],
    [
      "callback endpoint",
      {
        FILE_SCANNER_API_URL: "https://scanner.programcue.test",
        FILE_SCANNER_DISPATCH_SECRET:
          "scanner-test-dispatch-secret-long-enough",
        BETTER_AUTH_URL: undefined,
      },
      "callback-endpoint",
    ],
    [
      "queue binding",
      {
        FILE_SCANNER_API_URL: "https://scanner.programcue.test",
        FILE_SCANNER_DISPATCH_SECRET:
          "scanner-test-dispatch-secret-long-enough",
        BETTER_AUTH_URL: "https://programcue.test",
        OPERATIONS_QUEUE: undefined,
      },
      "queue-binding",
    ],
  ])(
    "classifies missing %s configuration safely",
    (_label, overrides, reason) => {
      let failure: unknown;
      try {
        assertFileScanDispatchConfigured({
          ...(env as unknown as CloudflareEnvironment),
          ...overrides,
        } as CloudflareEnvironment);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(FileScanDispatchConfigurationError);
      expect(failure).toMatchObject({ reason });
    },
  );

  it("delays a duplicate delivery while the exact operation has an active lease", async () => {
    const versionId = crypto.randomUUID();
    const operationId = `file-scan-dispatch:${versionId}`;
    const message: FileScanQueueMessage = {
      type: "file.scan.dispatch",
      operationId,
      organisationId: "org-future-events",
      eventId: "evt-foe-2025",
      versionId,
      assetId: crypto.randomUUID(),
      objectKey: `private/test/${versionId}`,
      objectEtag: '"0123456789abcdef0123456789abcdef"',
      sizeBytes: 128,
      idempotencyKey: `file.scan.dispatch:${versionId}`,
    };
    await env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         progress_total, progress_completed, progress_failed, cancellable,
         claim_token, claim_expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'file.scan.dispatch', ?, ?, 'running', ?,
                 1, 0, 0, 0, ?, unixepoch() + 60, unixepoch(), unixepoch())`,
    )
      .bind(
        operationId,
        message.organisationId,
        message.eventId,
        "person-demo-speaker",
        message.idempotencyKey,
        operationId,
        JSON.stringify(message),
        crypto.randomUUID(),
      )
      .run();

    await expect(
      processFileScanDispatch(message, env as unknown as CloudflareEnvironment),
    ).rejects.toBeInstanceOf(QueueClaimLeaseBusyError);
    const row = await env.DB.prepare(
      "SELECT status, claim_token AS claimToken FROM operation_jobs WHERE id = ?",
    )
      .bind(operationId)
      .first<{ status: string; claimToken: string | null }>();
    expect(row?.status).toBe("running");
    expect(row?.claimToken).not.toBeNull();
  });

  it("terminates a revoked scan without issuing access to the erased object", async () => {
    const versionId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const message: FileScanQueueMessage = {
      type: "file.scan.dispatch",
      operationId: `file-scan-dispatch:${versionId}`,
      organisationId: "org-future-events",
      eventId: "evt-foe-2025",
      versionId,
      assetId,
      objectKey: `private/test/${versionId}`,
      objectEtag: '"0123456789abcdef0123456789abcdef"',
      sizeBytes: 128,
      idempotencyKey: `file.scan.dispatch:${versionId}`,
    };
    await persistQueuedScan(message);
    await env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id, action, entity_type, entity_id,
         created_at
       ) VALUES (?, 'system', 'internal', 1, ?, ?, 'file.erasure.requested', 'file_asset', ?, unixepoch())`,
    )
      .bind(
        `file-erasure:${assetId}`,
        message.organisationId,
        message.eventId,
        assetId,
      )
      .run();
    let headCalls = 0;
    const files = new Proxy(env.FILES, {
      get(target, property) {
        if (property === "head")
          return async () => {
            headCalls += 1;
            return null;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const testEnvironment = {
      ...(env as unknown as CloudflareEnvironment),
      DB: env.DB,
      FILES: files,
    } as CloudflareEnvironment;

    await expect(
      processFileScanDispatch(message, testEnvironment),
    ).resolves.toEqual({ duplicate: false, skipped: true });
    expect(headCalls).toBe(0);
    const operation = await env.DB.prepare(
      `SELECT status, result_json AS resultJson, claim_token AS claimToken
         FROM operation_jobs WHERE id = ?`,
    )
      .bind(message.operationId)
      .first<{
        status: string;
        resultJson: string;
        claimToken: string | null;
      }>();
    expect(operation).toMatchObject({ status: "completed", claimToken: null });
    expect(JSON.parse(operation!.resultJson)).toEqual({
      accepted: false,
      skipped: true,
      reason: "file_unavailable",
    });
    await expect(
      env.DB.prepare(
        `SELECT action FROM audit_events
          WHERE id = ? AND event_id = ? AND entity_id = ?`,
      )
        .bind(
          `file-scan-dispatch-skipped:${versionId}`,
          message.eventId,
          versionId,
        )
        .first(),
    ).resolves.toEqual({ action: "file.scan.dispatch_skipped" });
  });

  it("fails closed before dispatch when R2 no longer matches the queued object", async () => {
    const versionId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const message: FileScanQueueMessage = {
      type: "file.scan.dispatch",
      operationId: `file-scan-dispatch:${versionId}`,
      organisationId: "org-future-events",
      eventId: "evt-foe-2025",
      versionId,
      assetId,
      objectKey: `private/test/${versionId}`,
      objectEtag: '"queued-object-etag"',
      sizeBytes: bytes.byteLength,
      idempotencyKey: `file.scan.dispatch:${versionId}`,
    };
    await persistQueuedScan(message);
    await env.FILES.put(message.objectKey, bytes, {
      customMetadata: {
        eventId: message.eventId,
        assetId: message.assetId,
        versionId: message.versionId,
        quarantine: "pending-scan",
      },
    });

    await expect(
      processFileScanDispatch(message, env as unknown as CloudflareEnvironment),
    ).rejects.toBeInstanceOf(FileScanDispatchIntegrityError);
    await expect(
      env.DB.prepare(
        `SELECT status, claim_token AS claimToken
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(message.operationId)
        .first(),
    ).resolves.toEqual({ status: "failed", claimToken: null });
    await expect(env.FILES.delete(message.objectKey)).resolves.toBeUndefined();
  });

  it("bounds a scanner provider error body before persisting the failure", async () => {
    const versionId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const objectKey = `private/test/${versionId}`;
    const object = await env.FILES.put(objectKey, bytes, {
      customMetadata: {
        eventId: "evt-foe-2025",
        assetId,
        versionId,
        quarantine: "pending-scan",
      },
    });
    const message: FileScanQueueMessage = {
      type: "file.scan.dispatch",
      operationId: `file-scan-dispatch:${versionId}`,
      organisationId: "org-future-events",
      eventId: "evt-foe-2025",
      versionId,
      assetId,
      objectKey,
      objectEtag: object.httpEtag,
      sizeBytes: bytes.byteLength,
      idempotencyKey: `file.scan.dispatch:${versionId}`,
    };
    await persistQueuedScan(message);
    const scanner = vi.fn(
      async () =>
        new Response("x".repeat(1_000), {
          status: 502,
          headers: { "content-length": "1000" },
        }),
    );
    vi.stubGlobal("fetch", scanner);

    await expect(
      processFileScanDispatch(message, env as unknown as CloudflareEnvironment),
    ).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(scanner).toHaveBeenCalledTimes(1);
    await expect(
      env.DB.prepare(
        `SELECT status, claim_token AS claimToken
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(message.operationId)
        .first(),
    ).resolves.toEqual({ status: "failed", claimToken: null });
    await expect(env.FILES.delete(objectKey)).resolves.toBeUndefined();
  });

  it("keeps an accepted scan retryable until its authenticated callback completes it", async () => {
    const versionId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const objectKey = `private/test/${versionId}`;
    const object = await env.FILES.put(objectKey, bytes, {
      customMetadata: {
        eventId: "evt-foe-2025",
        assetId,
        versionId,
        quarantine: "pending-scan",
      },
    });
    const message: FileScanQueueMessage = {
      type: "file.scan.dispatch",
      operationId: `file-scan-dispatch:${versionId}`,
      organisationId: "org-future-events",
      eventId: "evt-foe-2025",
      versionId,
      assetId,
      objectKey,
      objectEtag: object.httpEtag,
      sizeBytes: bytes.byteLength,
      idempotencyKey: `file.scan.dispatch:${versionId}`,
    };
    await persistQueuedScan(message);
    const scanner = vi.fn(
      async (
        _input: Parameters<typeof fetch>[0],
        _init?: Parameters<typeof fetch>[1],
      ) => new Response(null, { status: 202 }),
    );
    vi.stubGlobal("fetch", scanner);

    await expect(
      processFileScanDispatch(message, env as unknown as CloudflareEnvironment),
    ).resolves.toEqual({ duplicate: false, awaitingCallback: true });
    const awaiting = await env.DB.prepare(
      `SELECT status, progress_completed AS progressCompleted,
              claim_token AS claimToken, claim_expires_at AS claimExpiresAt
         FROM operation_jobs WHERE id = ?`,
    )
      .bind(message.operationId)
      .first<{
        status: string;
        progressCompleted: number;
        claimToken: string | null;
        claimExpiresAt: number | null;
      }>();
    expect(awaiting).toMatchObject({
      status: "running",
      progressCompleted: 0,
      claimToken: null,
    });
    expect(awaiting!.claimExpiresAt).toBeGreaterThan(
      Math.floor(Date.now() / 1_000),
    );

    await env.DB.prepare(
      "UPDATE operation_jobs SET claim_expires_at = unixepoch() - 1 WHERE id = ?",
    )
      .bind(message.operationId)
      .run();
    await expect(
      processFileScanDispatch(message, env as unknown as CloudflareEnvironment),
    ).resolves.toEqual({ duplicate: false, awaitingCallback: true });
    expect(scanner).toHaveBeenCalledTimes(2);
    const dispatchedAttempts = scanner.mock.calls.map(([, init]) => ({
      idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
      body: JSON.parse(String(init?.body)) as {
        jobId: string;
        attempt: number;
      },
    }));
    expect(dispatchedAttempts).toEqual([
      {
        idempotencyKey: `${message.operationId}:attempt:1`,
        body: expect.objectContaining({
          jobId: message.operationId,
          attempt: 1,
        }),
      },
      {
        idempotencyKey: `${message.operationId}:attempt:2`,
        body: expect.objectContaining({
          jobId: message.operationId,
          attempt: 2,
        }),
      },
    ]);
    await expect(
      env.DB.prepare(
        `SELECT id, json_extract(metadata_json, '$.attempt') AS attempt
           FROM audit_events
          WHERE id IN (?, ?)
          ORDER BY attempt`,
      )
        .bind(
          `file-scan-dispatched:${versionId}:attempt:1`,
          `file-scan-dispatched:${versionId}:attempt:2`,
        )
        .all(),
    ).resolves.toMatchObject({
      results: [
        {
          id: `file-scan-dispatched:${versionId}:attempt:1`,
          attempt: 1,
        },
        {
          id: `file-scan-dispatched:${versionId}:attempt:2`,
          attempt: 2,
        },
      ],
    });
    for (const [, init] of scanner.mock.calls) {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as {
        organisationId: string;
        expiresAt: number;
        object: { key: string };
      };
      expect(headers.has("authorization")).toBe(false);
      expect(await dispatchSignatureIsValid(init)).toBe(true);
      expect(body).toMatchObject({
        organisationId: message.organisationId,
        object: { key: message.objectKey },
      });
      expect(body.expiresAt).toBe(
        Number(headers.get("x-program-cue-dispatch-timestamp")) + 300,
      );
    }

    await new FileService(
      env as unknown as CloudflareEnvironment,
    ).recordScanResult({
      jobId: message.operationId,
      attempt: 2,
      organisationId: message.organisationId,
      eventId: message.eventId,
      versionId: message.versionId,
      assetId: message.assetId,
      objectKey: message.objectKey,
      objectEtag: message.objectEtag,
      sizeBytes: message.sizeBytes,
      provider: "test-scanner",
      callbackId: `callback-${message.versionId}`,
      status: "clean",
      result: { verdict: "clean" },
    });
    await expect(
      env.DB.prepare(
        `SELECT status, progress_completed AS progressCompleted,
                claim_expires_at AS claimExpiresAt
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(message.operationId)
        .first(),
    ).resolves.toEqual({
      status: "completed",
      progressCompleted: 1,
      claimExpiresAt: null,
    });
    await expect(env.FILES.delete(objectKey)).resolves.toBeUndefined();
  });

  it("accepts a scanner callback that arrives before the dispatch response", async () => {
    const versionId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const objectKey = `private/test/${versionId}`;
    const object = await env.FILES.put(objectKey, bytes, {
      customMetadata: {
        eventId: "evt-foe-2025",
        assetId,
        versionId,
        quarantine: "pending-scan",
      },
    });
    const message: FileScanQueueMessage = {
      type: "file.scan.dispatch",
      operationId: `file-scan-dispatch:${versionId}`,
      organisationId: "org-future-events",
      eventId: "evt-foe-2025",
      versionId,
      assetId,
      objectKey,
      objectEtag: object.httpEtag,
      sizeBytes: bytes.byteLength,
      idempotencyKey: `file.scan.dispatch:${versionId}`,
    };
    await persistQueuedScan(message);
    const scanner = vi.fn(async () => {
      await new FileService(
        env as unknown as CloudflareEnvironment,
      ).recordScanResult({
        jobId: message.operationId,
        attempt: 1,
        organisationId: message.organisationId,
        eventId: message.eventId,
        versionId: message.versionId,
        assetId: message.assetId,
        objectKey: message.objectKey,
        objectEtag: message.objectEtag,
        sizeBytes: message.sizeBytes,
        provider: "test-scanner",
        callbackId: `callback-${message.versionId}`,
        status: "clean",
        result: { verdict: "clean" },
      });
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", scanner);

    await expect(
      processFileScanDispatch(message, env as unknown as CloudflareEnvironment),
    ).resolves.toEqual({ duplicate: true });
    expect(scanner).toHaveBeenCalledTimes(1);
    await expect(
      env.DB.prepare(
        `SELECT operation.status,
                json_extract(operation.result_json, '$.callbackReceived') AS callbackReceived,
                version.scan_status AS scanStatus
           FROM operation_jobs operation
           JOIN file_versions version
             ON version.id = ? AND version.event_id = operation.event_id
          WHERE operation.id = ?`,
      )
        .bind(versionId, message.operationId)
        .first(),
    ).resolves.toEqual({
      status: "completed",
      callbackReceived: 1,
      scanStatus: "clean",
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id = ?")
        .bind(`file-scan-dispatched:${versionId}:attempt:1`)
        .first(),
    ).resolves.toEqual({ count: 1 });
    await expect(env.FILES.delete(objectKey)).resolves.toBeUndefined();
  });
});
