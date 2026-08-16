import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptTestFileScanDispatch,
  completeTestDirectUpload,
  testFileScanCallbackIdentity,
} from "~/modules/files/direct-upload.test-helper";
import { processFileScanDispatch } from "~/modules/files/file-scan-dispatch.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { OperationService } from "~/platform/operations/operation-service.server";
import { action } from "./api-file-scanner-webhook";

const scannerSecret =
  "file-scanner-callback-test-secret-with-at-least-32-characters";

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
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

type ScannerTestEnvironment = CloudflareEnvironment & {
  FILE_SCANNER_WEBHOOK_SECRET?: string;
};

function context(environment: ScannerTestEnvironment) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return context;
}

async function scannerRequest(
  payload: unknown,
  options: {
    callbackId?: string;
    secret?: string;
    timestamp?: number;
    contentType?: string;
  } = {},
) {
  const rawBody =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  const callbackId = options.callbackId ?? `scan-${crypto.randomUUID()}`;
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1_000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.secret ?? scannerSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${callbackId}.${timestamp}.${rawBody}`),
    ),
  );
  return new Request("https://programcue.test/api/webhooks/file-scanner", {
    method: "POST",
    headers: {
      "content-type": options.contentType ?? "application/json",
      "x-program-cue-scanner-id": callbackId,
      "x-program-cue-scanner-timestamp": timestamp,
      "x-program-cue-scanner-signature": `v1,${btoa(
        String.fromCharCode(...signature),
      )}`,
    },
    body: rawBody,
  });
}

function png(name: string) {
  return new File(
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
        crypto.getRandomValues(new Uint8Array(1))[0],
      ]),
    ],
    name,
    { type: "image/png" },
  );
}

function callbackIdentity(identity: {
  jobId: string;
  attempt: number;
  organisationId: string;
  assetId: string;
  objectKey: string;
  objectEtag: string;
  sizeBytes: number;
}) {
  return {
    jobId: identity.jobId,
    attempt: identity.attempt,
    organisationId: identity.organisationId,
    assetId: identity.assetId,
    object: {
      key: identity.objectKey,
      etag: identity.objectEtag,
      sizeBytes: identity.sizeBytes,
    },
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await ensureDemoSpeakerData(env as unknown as CloudflareEnvironment);
});

describe("authenticated file scanner callback", () => {
  it("applies a clean result once and treats the same signed callback as a duplicate", async () => {
    const testEnvironment = {
      ...(env as unknown as CloudflareEnvironment),
      FILE_SCANNER_WEBHOOK_SECRET: scannerSecret,
    } as ScannerTestEnvironment;
    const upload = await completeTestDirectUpload(
      testEnvironment,
      speaker,
      {
        targetType: "person",
        targetId: speaker.personId,
        assetKind: "headshot",
      },
      png(`scanner-clean-${crypto.randomUUID()}.png`),
    );
    const scanIdentity = await acceptTestFileScanDispatch(
      testEnvironment,
      speaker.eventId,
      upload.versionId,
    );
    const callbackId = `callback-${crypto.randomUUID()}`;
    const payload = {
      ...callbackIdentity(scanIdentity),
      eventId: speaker.eventId,
      versionId: upload.versionId,
      provider: "managed-scanner",
      verdict: "clean",
      result: { engine: "clamav", definitions: "2026-08-09" },
    };

    const [first, replay] = await Promise.all(
      [1, 2].map(async () =>
        action({
          request: await scannerRequest(payload, { callbackId }),
          params: {},
          context: context(testEnvironment),
        } as never),
      ),
    );
    expect([first.status, replay.status]).toEqual([200, 200]);
    const results = (await Promise.all([
      first.json(),
      replay.json(),
    ])) as Array<{
      applied: boolean;
      duplicate: boolean;
    }>;
    expect(
      results
        .map((result) => ({
          applied: result.applied,
          duplicate: result.duplicate,
        }))
        .sort((left, right) => Number(right.applied) - Number(left.applied)),
    ).toEqual([
      { applied: true, duplicate: false },
      { applied: false, duplicate: true },
    ]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE id = ?",
      )
        .bind(`file-scan:${upload.versionId}:attempt:${scanIdentity.attempt}`)
        .first(),
    ).toEqual({ count: 1 });

    const conflict = await action({
      request: await scannerRequest(
        { ...payload, verdict: "infected", result: { signature: "EICAR" } },
        { callbackId: `different-${crypto.randomUUID()}` },
      ),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(conflict.status).toBe(409);
  });

  it("records an explicit scanner error without releasing the quarantined bytes", async () => {
    const queueSend = vi.fn(async () => undefined);
    const testEnvironment = {
      ...(env as unknown as CloudflareEnvironment),
      FILE_SCANNER_WEBHOOK_SECRET: scannerSecret,
      OPERATIONS_QUEUE: {
        send: queueSend,
      } as unknown as Queue,
    } as ScannerTestEnvironment;
    const upload = await completeTestDirectUpload(
      testEnvironment,
      administrator,
      {
        targetType: "resource",
        targetId: "resource-speaker-handbook",
        assetKind: "resource_attachment",
      },
      new File(["%PDF-1.7 scanner error"], "scanner-error.pdf", {
        type: "application/pdf",
      }),
    );
    const scanIdentity = await acceptTestFileScanDispatch(
      testEnvironment,
      administrator.eventId,
      upload.versionId,
    );
    const errorPayload = {
      ...callbackIdentity(scanIdentity),
      eventId: administrator.eventId,
      versionId: upload.versionId,
      provider: "managed-scanner",
      verdict: "error" as const,
      error: "Provider could not inspect the archive.",
      result: { providerCode: "inspection_failed" },
    };
    const response = await action({
      request: await scannerRequest(errorPayload),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(response.status).toBe(200);
    expect(
      await env.DB.prepare(
        `SELECT fv.scan_status AS scanStatus, fv.scan_error AS scanError,
                fv.released_at AS releasedAt, fa.status AS assetStatus
           FROM file_versions fv JOIN file_assets fa ON fa.id = fv.asset_id
          WHERE fv.id = ?`,
      )
        .bind(upload.versionId)
        .first(),
    ).toEqual({
      scanStatus: "failed",
      scanError: "Provider could not inspect the archive.",
      releasedAt: null,
      assetStatus: "pending",
    });
    await expect(
      env.DB.prepare(
        `SELECT status, progress_completed AS progressCompleted,
                progress_failed AS progressFailed, last_error AS lastError
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(scanIdentity.jobId)
        .first(),
    ).resolves.toEqual({
      status: "failed",
      progressCompleted: 0,
      progressFailed: 1,
      lastError: "Provider could not inspect the archive.",
    });

    await new OperationService(testEnvironment).retry(
      administrator,
      scanIdentity.jobId,
    );
    await expect(
      env.DB.prepare(
        `SELECT version.scan_status AS scanStatus,
                asset.status AS assetStatus, operation.status AS operationStatus
           FROM file_versions version
           JOIN file_assets asset
             ON asset.id = version.asset_id AND asset.event_id = version.event_id
           JOIN operation_jobs operation ON operation.id = ?
          WHERE version.id = ?`,
      )
        .bind(scanIdentity.jobId, upload.versionId)
        .first(),
    ).resolves.toEqual({
      scanStatus: "failed",
      assetStatus: "pending",
      operationStatus: "queued",
    });
    expect(queueSend).toHaveBeenCalledOnce();

    const queued = await env.DB.prepare(
      "SELECT payload_json AS payloadJson FROM operation_jobs WHERE id = ?",
    )
      .bind(scanIdentity.jobId)
      .first<{ payloadJson: string }>();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
    await processFileScanDispatch(
      JSON.parse(queued!.payloadJson),
      testEnvironment,
    );
    const staleCallback = await action({
      request: await scannerRequest(errorPayload),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(staleCallback.status).toBe(409);
    await expect(
      env.DB.prepare(
        `SELECT version.scan_status AS scanStatus,
                asset.status AS assetStatus, operation.status AS operationStatus
           FROM file_versions version
           JOIN file_assets asset
             ON asset.id = version.asset_id AND asset.event_id = version.event_id
           JOIN operation_jobs operation ON operation.id = ?
          WHERE version.id = ?`,
      )
        .bind(scanIdentity.jobId, upload.versionId)
        .first(),
    ).resolves.toEqual({
      scanStatus: "pending",
      assetStatus: "pending",
      operationStatus: "running",
    });
  });

  it("does not release a file when the required verdict audit is suppressed", async () => {
    const testEnvironment = {
      ...(env as unknown as CloudflareEnvironment),
      FILE_SCANNER_WEBHOOK_SECRET: scannerSecret,
    } as ScannerTestEnvironment;
    const upload = await completeTestDirectUpload(
      testEnvironment,
      speaker,
      {
        targetType: "person",
        targetId: speaker.personId,
        assetKind: "headshot",
      },
      png(`scanner-audit-${crypto.randomUUID()}.png`),
    );
    const scanIdentity = await acceptTestFileScanDispatch(
      testEnvironment,
      speaker.eventId,
      upload.versionId,
    );
    await env.DB.prepare(
      `CREATE TRIGGER suppress_file_verdict_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.action = 'file.scan.clean'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();
    try {
      const response = await action({
        request: await scannerRequest(
          {
            ...callbackIdentity(scanIdentity),
            eventId: speaker.eventId,
            versionId: upload.versionId,
            provider: "managed-scanner",
            verdict: "clean",
            result: { engine: "clamav" },
          },
          { callbackId: `callback-${crypto.randomUUID()}` },
        ),
        params: {},
        context: context(testEnvironment),
      } as never);
      expect(response.status).toBe(409);
      await expect(
        env.DB.prepare(
          `SELECT scan_status AS scanStatus, released_at AS releasedAt
             FROM file_versions WHERE id = ?`,
        )
          .bind(upload.versionId)
          .first(),
      ).resolves.toEqual({ scanStatus: "pending", releasedAt: null });
    } finally {
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS suppress_file_verdict_audit",
      ).run();
    }
  });

  it("does not release a clean verdict when the quarantined R2 object is missing", async () => {
    const testEnvironment = {
      ...(env as unknown as CloudflareEnvironment),
      FILE_SCANNER_WEBHOOK_SECRET: scannerSecret,
    } as ScannerTestEnvironment;
    const upload = await completeTestDirectUpload(
      testEnvironment,
      speaker,
      {
        targetType: "person",
        targetId: speaker.personId,
        assetKind: "headshot",
      },
      png(`missing-quarantine-${crypto.randomUUID()}.png`),
    );
    const scanIdentity = await acceptTestFileScanDispatch(
      testEnvironment,
      speaker.eventId,
      upload.versionId,
    );
    const stored = await env.DB.prepare(
      "SELECT object_key AS objectKey FROM file_versions WHERE id = ?",
    )
      .bind(upload.versionId)
      .first<{ objectKey: string }>();
    await env.FILES.delete(stored!.objectKey);

    const response = await action({
      request: await scannerRequest({
        ...callbackIdentity(scanIdentity),
        eventId: speaker.eventId,
        versionId: upload.versionId,
        provider: "managed-scanner",
        verdict: "clean",
        result: { engine: "clamav" },
      }),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(response.status).toBe(409);
    expect(
      await env.DB.prepare(
        "SELECT scan_status AS scanStatus, released_at AS releasedAt FROM file_versions WHERE id = ?",
      )
        .bind(upload.versionId)
        .first(),
    ).toEqual({ scanStatus: "pending", releasedAt: null });
  });

  it("rejects a verdict until the exact durable object dispatch was accepted", async () => {
    const testEnvironment = {
      ...(env as unknown as CloudflareEnvironment),
      FILE_SCANNER_WEBHOOK_SECRET: scannerSecret,
    } as ScannerTestEnvironment;
    const upload = await completeTestDirectUpload(
      testEnvironment,
      speaker,
      {
        targetType: "person",
        targetId: speaker.personId,
        assetKind: "headshot",
      },
      png(`undispatched-${crypto.randomUUID()}.png`),
    );
    const identity = await testFileScanCallbackIdentity(
      testEnvironment,
      speaker.eventId,
      upload.versionId,
    );
    const verdict = {
      ...callbackIdentity(identity),
      eventId: speaker.eventId,
      versionId: upload.versionId,
      provider: "managed-scanner",
      verdict: "clean" as const,
      result: { engine: "clamav" },
    };

    const beforeAcceptance = await action({
      request: await scannerRequest(verdict),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(beforeAcceptance.status).toBe(409);

    await acceptTestFileScanDispatch(
      testEnvironment,
      speaker.eventId,
      upload.versionId,
    );
    const wrongObject = await action({
      request: await scannerRequest({
        ...verdict,
        object: {
          key: identity.objectKey,
          etag: '"different-object"',
          sizeBytes: identity.sizeBytes,
        },
      }),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(wrongObject.status).toBe(409);
    await expect(
      env.DB.prepare(
        `SELECT version.scan_status AS scanStatus,
                version.released_at AS releasedAt, operation.status
           FROM file_versions version
           JOIN operation_jobs operation
             ON operation.id = ? AND operation.event_id = version.event_id
          WHERE version.id = ? AND version.event_id = ?`,
      )
        .bind(identity.jobId, upload.versionId, speaker.eventId)
        .first(),
    ).resolves.toEqual({
      scanStatus: "pending",
      releasedAt: null,
      status: "running",
    });
  });

  it("authenticates the raw body before parsing it and rejects stale or invalid signatures", async () => {
    const testEnvironment = {
      ...(env as unknown as CloudflareEnvironment),
      FILE_SCANNER_WEBHOOK_SECRET: scannerSecret,
    } as ScannerTestEnvironment;
    const badSignature = await action({
      request: await scannerRequest("not-json", {
        secret: "different-file-scanner-secret-with-at-least-32-characters",
      }),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(badSignature.status).toBe(401);

    const stale = await action({
      request: await scannerRequest("not-json", {
        timestamp: Math.floor(Date.now() / 1_000) - 301,
      }),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(stale.status).toBe(401);

    const authenticatedMalformed = await action({
      request: await scannerRequest("not-json"),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(authenticatedMalformed.status).toBe(400);

    const authenticatedWrongMediaType = await action({
      request: await scannerRequest("not-json", {
        contentType: "text/plain",
      }),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(authenticatedWrongMediaType.status).toBe(415);

    const authenticatedExtraField = await action({
      request: await scannerRequest({
        eventId: speaker.eventId,
        versionId: crypto.randomUUID(),
        provider: "managed-scanner",
        verdict: "clean",
        result: { engine: "clamav" },
        undeclaredCredential: "must-not-be-accepted",
      }),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(authenticatedExtraField.status).toBe(400);

    for (const invalidConditionalPayload of [
      {
        eventId: speaker.eventId,
        versionId: crypto.randomUUID(),
        provider: "managed-scanner",
        verdict: "error",
      },
      {
        eventId: speaker.eventId,
        versionId: crypto.randomUUID(),
        provider: "managed-scanner",
        verdict: "clean",
        error: "Only error verdicts may carry this field.",
      },
    ]) {
      const conditional = await action({
        request: await scannerRequest(invalidConditionalPayload),
        params: {},
        context: context(testEnvironment),
      } as never);
      expect(conditional.status).toBe(400);
    }
  });

  it("fails explicitly when the scanner secret is not configured", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await action({
      request: new Request(
        "https://programcue.test/api/webhooks/file-scanner",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      ),
      params: {},
      context: context(env as unknown as ScannerTestEnvironment),
    } as never);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "File scanner callback configuration is unavailable.",
    });
    expect(logged).toHaveBeenCalledTimes(1);
    const entry = String(logged.mock.calls[0]?.[0]);
    expect(JSON.parse(entry)).toMatchObject({
      subsystem: "file-scanner-callback",
      event: "configuration-unavailable",
      errorName: "ScannerCallbackConfigurationError",
    });
    expect(entry).not.toContain("FILE_SCANNER_WEBHOOK_SECRET");
  });
});
