import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import { OperationService } from "~/platform/operations/operation-service.server";
import { processAcceleventsExport } from "../../../workers/queue/accelevents-export-handler";
import { IntegrationService } from "./integration-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

async function startLiveRun(
  service: IntegrationService,
  input: { connectionId: string; idempotencyKey: string },
) {
  const preview = await service.preview(viewer, input.connectionId);
  return service.startRun(viewer, {
    ...input,
    dryRun: false,
    previewFingerprint: preview.previewFingerprint,
  });
}

describe("Accelevents integration service", () => {
  beforeEach(async () => {
    await new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    ).getPublished("future-of-events-2025");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM integration_entity_mappings"),
      env.DB.prepare("DELETE FROM integration_runs"),
      env.DB.prepare("DELETE FROM integration_connections"),
      env.DB.prepare(
        "DELETE FROM operation_jobs WHERE type = 'integration.accelevents.export'",
      ),
    ]);
  });

  it("fails closed before building an Accelevents preview from an unreadable Airtable projection", async () => {
    const unavailable = new Error("Airtable projection is unavailable.");
    const assertReadable = vi.fn(async () => {
      throw unavailable;
    });
    const service = new IntegrationService(
      env as unknown as CloudflareEnvironment,
      {
        airtable: { assertReadable } as unknown as AirtableProviderBoundary,
      },
    );

    await expect(service.preview(viewer, "connection-id")).rejects.toBe(
      unavailable,
    );
    expect(assertReadable).toHaveBeenCalledWith(viewer);
  });

  it("records dry-run diffs without enqueueing or calling provider writes", async () => {
    const enqueue = vi.fn(async () => undefined);
    const validateConnection = vi.fn(async () => undefined);
    const service = new IntegrationService(
      env as unknown as CloudflareEnvironment,
      {
        enqueue,
        createAccelevents: () => ({ validateConnection }),
      },
    );
    const configured = await service.configureAccelevents(viewer, {
      provider: "accelevents",
      apiKey: "provider-key",
      eventUrl: "future-of-events",
      externalEventId: 441,
      sessionTypeFormat: "IN_PERSON",
    });
    const preview = await service.preview(viewer, configured.connectionId);
    expect(preview.items.length).toBeGreaterThan(5);
    expect(preview.items.every((item) => item.action === "create")).toBe(true);

    const run = await service.startRun(viewer, {
      connectionId: configured.connectionId,
      dryRun: true,
      idempotencyKey: "dry-run-contract-1",
      previewFingerprint: preview.previewFingerprint,
    });
    expect(run.previewFingerprint).toBe(preview.previewFingerprint);
    expect(enqueue).not.toHaveBeenCalled();
    await expect(
      env.DB.prepare(
        `SELECT status, dry_run AS dryRun FROM integration_runs WHERE id = ?`,
      )
        .bind(run.runId)
        .first(),
    ).resolves.toMatchObject({ status: "succeeded", dryRun: 1 });
    const providerCalls = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM integration_run_items
        WHERE run_id = ? AND status <> 'skipped'`,
    )
      .bind(run.runId)
      .first<{ count: number }>();
    expect(providerCalls?.count).toBe(0);
  });

  it("requires an exact preview fingerprint before recording a live export", async () => {
    const service = new IntegrationService(
      env as unknown as CloudflareEnvironment,
      {
        createAccelevents: () => ({
          validateConnection: async () => undefined,
        }),
      },
    );
    const configured = await service.configureAccelevents(viewer, {
      provider: "accelevents",
      apiKey: "provider-key",
      eventUrl: "future-of-events",
      externalEventId: 441,
      sessionTypeFormat: "IN_PERSON",
    });

    await expect(
      service.startRun(viewer, {
        connectionId: configured.connectionId,
        dryRun: false,
        idempotencyKey: "live-preview-required-contract",
      }),
    ).rejects.toThrow(/previewFingerprint/iu);
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM integration_runs
          WHERE connection_id = ?`,
      )
        .bind(configured.connectionId)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("rejects a confirmation when the Accelevents preview is stale", async () => {
    const service = new IntegrationService(
      env as unknown as CloudflareEnvironment,
      {
        createAccelevents: () => ({
          validateConnection: async () => undefined,
        }),
      },
    );
    const configured = await service.configureAccelevents(viewer, {
      provider: "accelevents",
      apiKey: "provider-key",
      eventUrl: "future-of-events",
      externalEventId: 441,
      sessionTypeFormat: "IN_PERSON",
    });
    const preview = await service.preview(viewer, configured.connectionId);
    await env.DB.prepare(
      `UPDATE integration_connections
          SET revision = revision + 1
        WHERE id = ?`,
    )
      .bind(configured.connectionId)
      .run();

    await expect(
      service.startRun(viewer, {
        connectionId: configured.connectionId,
        dryRun: false,
        idempotencyKey: "stale-preview-contract-1",
        previewFingerprint: preview.previewFingerprint,
      }),
    ).rejects.toThrow("changed after it was previewed");
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM integration_runs
          WHERE connection_id = ?`,
      )
        .bind(configured.connectionId)
        .first<{ count: number }>(),
    ).resolves.toMatchObject({ count: 0 });
  });

  it("does not send a queued export through a reconfigured connection", async () => {
    let queued: unknown;
    const service = new IntegrationService(
      env as unknown as CloudflareEnvironment,
      {
        enqueue: async (message) => {
          queued = message;
        },
        createAccelevents: () => ({
          validateConnection: async () => undefined,
        }),
      },
    );
    const configured = await service.configureAccelevents(viewer, {
      provider: "accelevents",
      apiKey: "provider-key",
      eventUrl: "future-of-events",
      externalEventId: 441,
      sessionTypeFormat: "IN_PERSON",
    });
    await startLiveRun(service, {
      connectionId: configured.connectionId,
      idempotencyKey: "connection-revision-contract-1",
    });
    await env.DB.prepare(
      `UPDATE integration_connections
          SET revision = revision + 1
        WHERE id = ?`,
    )
      .bind(configured.connectionId)
      .run();
    const createProvider = vi.fn();

    await expect(
      processAcceleventsExport(
        queued,
        env as unknown as CloudflareEnvironment,
        { createProvider },
      ),
    ).rejects.toThrow("changed after preview");
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("blocks preview when a speaker has no explicit last name", async () => {
    const speaker = await env.DB.prepare(
      `SELECT person.id, person.display_name AS displayName
         FROM people person
         JOIN session_speakers speaker ON speaker.person_id = person.id
        WHERE speaker.event_id = ?
        ORDER BY person.id LIMIT 1`,
    )
      .bind(viewer.eventId)
      .first<{ id: string; displayName: string }>();
    expect(speaker).not.toBeNull();
    await env.DB.prepare(
      "UPDATE people SET display_name = 'Prince' WHERE id = ?",
    )
      .bind(speaker!.id)
      .run();
    try {
      const service = new IntegrationService(
        env as unknown as CloudflareEnvironment,
        {
          createAccelevents: () => ({
            validateConnection: async () => undefined,
          }),
        },
      );
      const configured = await service.configureAccelevents(viewer, {
        provider: "accelevents",
        apiKey: "provider-key",
        eventUrl: "future-of-events",
        externalEventId: 441,
        sessionTypeFormat: "IN_PERSON",
      });

      await expect(
        service.preview(viewer, configured.connectionId),
      ).rejects.toThrow(
        /Speaker “Prince” needs both a first and last name.*update the speaker’s display name/iu,
      );
    } finally {
      await env.DB.prepare("UPDATE people SET display_name = ? WHERE id = ?")
        .bind(speaker!.displayName, speaker!.id)
        .run();
    }
  });

  it("keeps the explicit demo no-write fixture out of live and non-demo exports", async () => {
    const connectionId = `demo-no-write-${crypto.randomUUID()}`;
    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment;
    await env.DB.prepare(
      `INSERT INTO integration_connections (
         id, organisation_id, event_id, provider, status, direction,
         conflict_policy, encrypted_credentials, configuration_json,
         revision, created_at, updated_at
       ) VALUES (?, ?, ?, 'accelevents', 'connected', 'outbound',
                 'program_cue_wins', NULL, ?, 1, unixepoch(), unixepoch())`,
    )
      .bind(
        connectionId,
        viewer.organisationId,
        viewer.eventId,
        JSON.stringify({
          eventUrl: "demo-no-write-fixture",
          externalEventId: 1,
          sessionTypeFormat: "IN_PERSON",
          demoNoWriteFixture: true,
        }),
      )
      .run();
    const enqueue = vi.fn(async () => undefined);
    const service = new IntegrationService(testEnv, { enqueue });
    await expect(service.getWorkspace(viewer)).resolves.toMatchObject({
      connections: expect.arrayContaining([
        expect.objectContaining({
          id: connectionId,
          demoNoWriteFixture: true,
          hasCredentials: false,
        }),
      ]),
    });
    const demoPreview = await service.preview(viewer, connectionId);
    expect(demoPreview).toMatchObject({
      connection: { id: connectionId, demoNoWriteFixture: true },
    });
    await expect(
      service.startRun(viewer, {
        connectionId,
        dryRun: true,
        idempotencyKey: "demo-no-write-dry-run",
      }),
    ).resolves.toMatchObject({ queued: false });
    expect(enqueue).not.toHaveBeenCalled();
    await expect(
      service.startRun(viewer, {
        connectionId,
        dryRun: false,
        idempotencyKey: "demo-no-write-live-run",
        previewFingerprint: demoPreview.previewFingerprint,
      }),
    ).rejects.toThrow(/supports no-write dry runs only/iu);
    expect(enqueue).not.toHaveBeenCalled();

    const nonDemoService = new IntegrationService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    });
    await expect(nonDemoService.preview(viewer, connectionId)).rejects.toThrow(
      /cannot be used outside demo mode/iu,
    );

    const operationId = `demo-no-write-operation-${crypto.randomUUID()}`;
    const runId = `demo-no-write-run-${crypto.randomUUID()}`;
    const runItemId = `demo-no-write-run-item-${crypto.randomUUID()}`;
    const operationItemId = `demo-no-write-operation-item-${crypto.randomUUID()}`;
    const message = {
      type: "integration.accelevents.export" as const,
      operationId,
      runId,
      connectionId,
      connectionRevision: 1,
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
    };
    const diff = {
      label: "No-write session",
      payload: {
        title: "No-write session",
        startTime: "2025/05/20 10:00",
        endTime: "2025/05/20 11:00",
        format: "BREAKOUT_SESSION",
        status: "VISIBLE",
        sessionVisibilityType: "PUBLIC",
        sessionTypeFormat: "IN_PERSON",
      },
      sourceHash: "0".repeat(64),
      previousExternalId: null,
      changes: [{ field: "title", before: null, after: "No-write session" }],
      providerSupport: "supported",
      providerMessage: null,
    };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           progress_total, progress_completed, progress_failed, cancellable,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'integration.accelevents.export', ?, ?,
                   'queued', ?, 1, 0, 0, 0, unixepoch(), unixepoch())`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `demo-no-write-operation-${crypto.randomUUID()}`,
        crypto.randomUUID(),
        JSON.stringify(message),
      ),
      env.DB.prepare(
        `INSERT INTO integration_runs (
           id, connection_id, operation_id, idempotency_key, status,
           direction, dry_run, summary_json, created_at
         ) VALUES (?, ?, ?, ?, 'queued', 'outbound', 0,
                   '{"total":1,"create":1,"update":0,"noop":0,"blocked":0}',
                   unixepoch())`,
      ).bind(runId, connectionId, operationId, crypto.randomUUID()),
      env.DB.prepare(
        `INSERT INTO integration_run_items (
           id, run_id, entity_type, entity_id, action, status, diff_json,
           attempt_count, updated_at
         ) VALUES (?, ?, 'session', 'demo-no-write-session', 'create',
                   'pending', ?, 0, unixepoch())`,
      ).bind(runItemId, runId, JSON.stringify(diff)),
      env.DB.prepare(
        `INSERT INTO operation_items (
           id, operation_id, item_key, entity_type, entity_id, status,
           attempt_count, updated_at
         ) VALUES (?, ?, 'session:demo-no-write-session', 'session',
                   'demo-no-write-session', 'pending', 0, unixepoch())`,
      ).bind(operationItemId, operationId),
    ]);
    const createProvider = vi.fn();
    await processAcceleventsExport(message, testEnv, { createProvider });
    expect(createProvider).not.toHaveBeenCalled();
    await expect(
      env.DB.prepare(
        `SELECT operation.status, item.status AS itemStatus,
                item.attempt_count AS attempts, item.error_message AS error
           FROM operation_jobs operation
           JOIN operation_items item ON item.operation_id = operation.id
          WHERE operation.id = ?`,
      )
        .bind(operationId)
        .first(),
    ).resolves.toMatchObject({
      status: "failed",
      itemStatus: "failed",
      attempts: 1,
      error: expect.stringContaining(
        "Demo no-write fixture: no Accelevents request was made.",
      ),
    });

    await new OperationService(testEnv).retryItem(
      viewer,
      operationId,
      operationItemId,
    );
    await processAcceleventsExport(queued.shift(), testEnv, {
      createProvider,
    });
    expect(createProvider).not.toHaveBeenCalled();
    await expect(
      env.DB.prepare(
        `SELECT operation.status, item.status AS itemStatus,
                item.attempt_count AS attempts, item.error_message AS error
           FROM operation_jobs operation
           JOIN operation_items item ON item.operation_id = operation.id
          WHERE operation.id = ?`,
      )
        .bind(operationId)
        .first(),
    ).resolves.toMatchObject({
      status: "failed",
      itemStatus: "failed",
      attempts: 2,
      error: expect.stringContaining(
        "Demo no-write fixture: no Accelevents request was made.",
      ),
    });
  });

  it("releases an owned export claim when setup fails after the claim", async () => {
    let queued: unknown;
    const service = new IntegrationService(
      env as unknown as CloudflareEnvironment,
      {
        enqueue: async (message) => {
          queued = message;
        },
        createAccelevents: () => ({
          validateConnection: async () => undefined,
        }),
      },
    );
    const configured = await service.configureAccelevents(viewer, {
      provider: "accelevents",
      apiKey: "provider-key",
      eventUrl: "future-of-events",
      externalEventId: 441,
      sessionTypeFormat: "IN_PERSON",
    });
    const run = await startLiveRun(service, {
      connectionId: configured.connectionId,
      idempotencyKey: `post-claim-setup-failure-${crypto.randomUUID()}`,
    });
    await env.DB.prepare(
      "UPDATE integration_connections SET encrypted_credentials = NULL WHERE id = ?",
    )
      .bind(configured.connectionId)
      .run();
    const createProvider = vi.fn();

    await expect(
      processAcceleventsExport(
        queued,
        env as unknown as CloudflareEnvironment,
        { createProvider },
      ),
    ).rejects.toThrow("connected Accelevents credentials are unavailable");
    expect(createProvider).not.toHaveBeenCalled();

    const state = await env.DB.prepare(
      `SELECT operation.status AS operationStatus,
              operation.claim_token AS claimToken,
              operation.claim_expires_at AS claimExpiresAt,
              operation.progress_total AS progressTotal,
              operation.progress_completed AS progressCompleted,
              operation.progress_failed AS progressFailed,
              operation.last_error AS lastError,
              run.status AS runStatus,
              run.completed_at IS NOT NULL AS runCompleted,
              (SELECT COUNT(*) FROM operation_items
                WHERE operation_id = operation.id AND status = 'failed') AS failedOperationItems,
              (SELECT COUNT(*) FROM integration_run_items
                WHERE run_id = run.id AND status = 'failed') AS failedRunItems
         FROM operation_jobs operation
         JOIN integration_runs run ON run.operation_id = operation.id
        WHERE operation.id = ?`,
    )
      .bind(run.operationId)
      .first<{
        operationStatus: string;
        claimToken: string | null;
        claimExpiresAt: number | null;
        progressTotal: number;
        progressCompleted: number;
        progressFailed: number;
        lastError: string | null;
        runStatus: string;
        runCompleted: number;
        failedOperationItems: number;
        failedRunItems: number;
      }>();
    expect(state).toMatchObject({
      operationStatus: "failed",
      claimToken: null,
      claimExpiresAt: null,
      lastError: expect.stringContaining(
        "connected Accelevents credentials are unavailable",
      ),
      runStatus: "failed",
      runCompleted: 1,
    });
    expect(state?.progressTotal).toBeGreaterThan(0);
    expect(state?.progressCompleted).toBe(state?.progressTotal);
    expect(state?.progressFailed).toBe(state?.progressTotal);
    expect(state?.failedOperationItems).toBe(state?.progressTotal);
    expect(state?.failedRunItems).toBe(state?.progressTotal);
  });

  it("audits API-key exports without fabricating a person and rejects a changed idempotent request", async () => {
    const service = new IntegrationService(
      env as unknown as CloudflareEnvironment,
      {
        enqueue: async () => undefined,
        createAccelevents: () => ({
          validateConnection: async () => undefined,
        }),
      },
    );
    const configured = await service.configureAccelevents(viewer, {
      provider: "accelevents",
      apiKey: "provider-key",
      eventUrl: "future-of-events",
      externalEventId: 441,
      sessionTypeFormat: "IN_PERSON",
    });
    const actor = {
      kind: "api_key" as const,
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
      personId: null,
      actorId: "api_key:integration-contract-key",
    };
    const input = {
      connectionId: configured.connectionId,
      dryRun: true,
      idempotencyKey: "api-export-contract-1",
    };
    const results = await Promise.all([
      service.startRun(actor, input),
      service.startRun(actor, input),
    ]);
    const created = results.find((result) => !result.replayed)!;
    const replay = results.find((result) => result.replayed)!;
    expect(created.replayed).toBe(false);
    expect(replay).toMatchObject({
      runId: created.runId,
      operationId: created.operationId,
      replayed: true,
    });
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM integration_runs
          WHERE connection_id = ? AND idempotency_key = ?`,
      )
        .bind(input.connectionId, input.idempotencyKey)
        .first(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      service.startRun(actor, {
        ...input,
        previewFingerprint: "0".repeat(64),
      }),
    ).rejects.toThrow(/idempotency key.*different export request/iu);
    await expect(
      env.DB.prepare(
        `SELECT actor_person_id AS actorPersonId, actor_id AS actorId
           FROM audit_events
          WHERE action = 'integration.run.created' AND entity_id = ?`,
      )
        .bind(created.runId)
        .first(),
    ).resolves.toEqual({
      actorPersonId: null,
      actorId: actor.actorId,
    });
  });

  it("keeps Airtable repository connections out of the Accelevents workspace", async () => {
    const service = new IntegrationService(
      env as unknown as CloudflareEnvironment,
      {
        createAccelevents: () => ({
          validateConnection: async () => undefined,
        }),
      },
    );
    const configured = await service.configureAccelevents(viewer, {
      provider: "accelevents",
      apiKey: "provider-key",
      eventUrl: "future-of-events",
      externalEventId: 441,
      sessionTypeFormat: "IN_PERSON",
    });
    await env.DB.prepare(
      `INSERT INTO integration_connections (
         id, organisation_id, event_id, provider, status, direction,
         configuration_json, created_at, updated_at
       ) VALUES (?, ?, ?, 'airtable_repository', 'connected', 'bidirectional',
                 '{}', unixepoch(), unixepoch() + 1)`,
    )
      .bind(
        `airtable-${crypto.randomUUID()}`,
        viewer.organisationId,
        viewer.eventId,
      )
      .run();

    const workspace = await service.getWorkspace(viewer);
    expect(workspace.connections).toHaveLength(1);
    expect(workspace.connections[0]).toMatchObject({
      id: configured.connectionId,
      provider: "accelevents",
    });
  });

  it("processes a live export, persists stable mappings and makes the rerun a no-op", async () => {
    let queued: unknown;
    const service = new IntegrationService(
      env as unknown as CloudflareEnvironment,
      {
        enqueue: async (message) => {
          queued = message;
        },
        createAccelevents: () => ({
          validateConnection: async () => undefined,
        }),
      },
    );
    const configured = await service.configureAccelevents(viewer, {
      provider: "accelevents",
      apiKey: "provider-key",
      eventUrl: "future-of-events",
      externalEventId: 441,
      sessionTypeFormat: "IN_PERSON",
    });
    const firstPreview = await service.preview(
      viewer,
      configured.connectionId,
    );
    const first = await service.startRun(viewer, {
      connectionId: configured.connectionId,
      dryRun: false,
      idempotencyKey: "live-run-contract-1",
      previewFingerprint: firstPreview.previewFingerprint,
    });
    const upsertSpeaker = vi.fn(
      async (payload: { email: string }) => `speaker:${payload.email}`,
    );
    const createTrack = vi.fn(
      async (payload: { name: string }) => `track:${payload.name}`,
    );
    const updateTrack = vi.fn(
      async (_payload: { name: string }, externalId: string) => externalId,
    );
    const upsertSession = vi.fn(
      async (payload: { title: string }) => `session:${payload.title}`,
    );
    const associateSessionSpeaker = vi.fn(
      async (sessionId: string, speakerId: string) =>
        `${sessionId}:${speakerId}`,
    );
    const providerOrder: string[] = [];
    upsertSpeaker.mockImplementation(async (payload) => {
      providerOrder.push("speaker");
      return `speaker:${payload.email}`;
    });
    createTrack.mockImplementation(async (payload) => {
      providerOrder.push("track");
      return `track:${payload.name}`;
    });
    upsertSession.mockImplementation(async (payload) => {
      providerOrder.push("session");
      return `session:${payload.title}`;
    });
    associateSessionSpeaker.mockImplementation(async (sessionId, speakerId) => {
      providerOrder.push("session_speaker");
      return `${sessionId}:${speakerId}`;
    });
    await processAcceleventsExport(
      queued,
      env as unknown as CloudflareEnvironment,
      {
        createProvider: () => ({
          upsertSpeaker,
          createTrack,
          updateTrack,
          upsertSession,
          associateSessionSpeaker,
        }),
      },
    );
    const operation = await env.DB.prepare(
      `SELECT status, progress_total AS total, progress_completed AS completed,
              progress_failed AS failed
         FROM operation_jobs WHERE id = ?`,
    )
      .bind(first.operationId)
      .first();
    expect(operation).toMatchObject({
      status: "completed",
      total:
        upsertSpeaker.mock.calls.length +
        createTrack.mock.calls.length +
        upsertSession.mock.calls.length +
        associateSessionSpeaker.mock.calls.length,
      completed:
        upsertSpeaker.mock.calls.length +
        createTrack.mock.calls.length +
        upsertSession.mock.calls.length +
        associateSessionSpeaker.mock.calls.length,
      failed: 0,
    });
    const firstSession = providerOrder.indexOf("session");
    const firstAssociation = providerOrder.indexOf("session_speaker");
    expect(firstSession).toBeGreaterThan(-1);
    expect(firstAssociation).toBeGreaterThan(firstSession);
    expect(
      providerOrder
        .slice(0, firstSession)
        .every((entityType) => ["speaker", "track"].includes(entityType)),
    ).toBe(true);
    expect(
      providerOrder
        .slice(firstSession, firstAssociation)
        .every((entityType) => entityType === "session"),
    ).toBe(true);

    const mappingsBeforeReplay = (
      await env.DB.prepare(
        `SELECT id, entity_type AS entityType, entity_id AS entityId,
              external_id AS externalId, source_hash AS sourceHash
         FROM integration_entity_mappings
        WHERE connection_id = ? ORDER BY entity_type, entity_id`,
      )
        .bind(configured.connectionId)
        .all()
    ).results;
    queued = undefined;
    await expect(
      service.startRun(viewer, {
        connectionId: configured.connectionId,
        dryRun: false,
        idempotencyKey: "live-run-contract-1",
        previewFingerprint: firstPreview.previewFingerprint,
      }),
    ).resolves.toMatchObject({
      runId: first.runId,
      operationId: first.operationId,
      replayed: true,
    });
    expect(queued).toBeUndefined();
    expect(
      (
        await env.DB.prepare(
          `SELECT id, entity_type AS entityType, entity_id AS entityId,
                external_id AS externalId, source_hash AS sourceHash
           FROM integration_entity_mappings
          WHERE connection_id = ? ORDER BY entity_type, entity_id`,
        )
          .bind(configured.connectionId)
          .all()
      ).results,
    ).toEqual(mappingsBeforeReplay);

    const secondPreview = await service.preview(
      viewer,
      configured.connectionId,
    );
    expect(secondPreview.items.every((item) => item.action === "noop")).toBe(
      true,
    );
    queued = undefined;
    const second = await service.startRun(viewer, {
      connectionId: configured.connectionId,
      dryRun: false,
      idempotencyKey: "live-run-contract-2",
      previewFingerprint: secondPreview.previewFingerprint,
    });
    expect(queued).toBeUndefined();
    await expect(
      env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
        .bind(second.operationId)
        .first(),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("retries one failed item through the handler without resending successful records", async () => {
    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => {
          queued.push(message);
        },
      },
    } as unknown as CloudflareEnvironment;
    const service = new IntegrationService(testEnv, {
      enqueue: async (message) => {
        queued.push(message);
      },
      createAccelevents: () => ({
        validateConnection: async () => undefined,
      }),
    });
    const configured = await service.configureAccelevents(viewer, {
      provider: "accelevents",
      apiKey: "provider-key",
      eventUrl: "future-of-events",
      externalEventId: 441,
      sessionTypeFormat: "IN_PERSON",
    });
    const retrySession = await env.DB.prepare(
      "SELECT id FROM sessions WHERE event_id = ? ORDER BY id LIMIT 1",
    )
      .bind(viewer.eventId)
      .first<{ id: string }>();
    expect(retrySession).not.toBeNull();
    await env.DB.prepare(
      `INSERT INTO integration_entity_mappings (
         id, connection_id, entity_type, entity_id, external_id, source_hash,
         metadata_json, last_synced_at, created_at, updated_at
       ) VALUES (?, ?, 'session', ?, '813', ?, '{"payload":{}}',
                 unixepoch(), unixepoch(), unixepoch())`,
    )
      .bind(
        `retry-session-mapping-${crypto.randomUUID()}`,
        configured.connectionId,
        retrySession!.id,
        "0".repeat(64),
      )
      .run();
    const run = await startLiveRun(service, {
      connectionId: configured.connectionId,
      idempotencyKey: "single-item-retry-contract",
    });
    const upsertSpeaker = vi.fn(
      async (payload: { email: string }) => `speaker:${payload.email}`,
    );
    const createTrack = vi.fn(
      async (payload: { name: string }) => `track:${payload.name}`,
    );
    const updateTrack = vi.fn(
      async (_payload: { name: string }, externalId: string) => externalId,
    );
    let failNextSession = true;
    const upsertSession = vi.fn(async (payload: { title: string }) => {
      if (failNextSession) {
        failNextSession = false;
        throw new Error("A single session was rejected for this test.");
      }
      return `session:${payload.title}`;
    });
    const associateSessionSpeaker = vi.fn(
      async (sessionId: string, speakerId: string) =>
        `${sessionId}:${speakerId}`,
    );
    const dependencies = {
      createProvider: () => ({
        upsertSpeaker,
        createTrack,
        updateTrack,
        upsertSession,
        associateSessionSpeaker,
      }),
    };

    const originalMessage = queued.shift();
    await processAcceleventsExport(originalMessage, testEnv, dependencies);
    const partialProgress = await env.DB.prepare(
      `SELECT status, progress_total AS total,
              progress_completed AS completed, progress_failed AS failed
         FROM operation_jobs WHERE id = ?`,
    )
      .bind(run.operationId)
      .first<{
        status: string;
        total: number;
        completed: number;
        failed: number;
      }>();
    expect(partialProgress).toMatchObject({ status: "partially_failed" });
    expect(partialProgress?.completed).toBe(partialProgress?.total);
    expect(partialProgress?.failed).toBeGreaterThan(0);
    const callsAfterFirstAttempt = {
      speakers: upsertSpeaker.mock.calls.length,
      tracks: createTrack.mock.calls.length,
      sessions: upsertSession.mock.calls.length,
      associations: associateSessionSpeaker.mock.calls.length,
    };
    await processAcceleventsExport(originalMessage, testEnv, dependencies);
    expect({
      speakers: upsertSpeaker.mock.calls.length,
      tracks: createTrack.mock.calls.length,
      sessions: upsertSession.mock.calls.length,
      associations: associateSessionSpeaker.mock.calls.length,
    }).toEqual(callsAfterFirstAttempt);
    const failedSession = await env.DB.prepare(
      `SELECT item.id, item.entity_id AS entityId
         FROM operation_items item
        WHERE item.operation_id = ? AND item.entity_type = 'session'
          AND item.status = 'failed'`,
    )
      .bind(run.operationId)
      .first<{ id: string; entityId: string }>();
    expect(failedSession).not.toBeNull();

    await new OperationService(testEnv).retryItem(
      viewer,
      run.operationId!,
      failedSession!.id,
    );
    const targetedSessionMessage = queued.shift() as { itemId?: string };
    expect(targetedSessionMessage.itemId).toBeTruthy();
    await processAcceleventsExport(
      targetedSessionMessage,
      testEnv,
      dependencies,
    );
    expect(upsertSpeaker).toHaveBeenCalledTimes(
      callsAfterFirstAttempt.speakers,
    );
    expect(createTrack).toHaveBeenCalledTimes(callsAfterFirstAttempt.tracks);
    expect(upsertSession).toHaveBeenCalledTimes(
      callsAfterFirstAttempt.sessions + 1,
    );
    expect(associateSessionSpeaker).toHaveBeenCalledTimes(
      callsAfterFirstAttempt.associations,
    );
    await expect(
      env.DB.prepare(
        `SELECT status, progress_failed AS failed
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(run.operationId)
        .first(),
    ).resolves.toEqual({ status: "completed", failed: 0 });
    expect(associateSessionSpeaker).toHaveBeenCalledTimes(
      callsAfterFirstAttempt.associations,
    );
  });

  it("fails an ambiguous create retry without another provider write", async () => {
    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment;
    const service = new IntegrationService(testEnv, {
      enqueue: async (message) => {
        queued.push(message);
      },
      createAccelevents: () => ({
        validateConnection: async () => undefined,
      }),
    });
    const configured = await service.configureAccelevents(viewer, {
      provider: "accelevents",
      apiKey: "provider-key",
      eventUrl: "future-of-events",
      externalEventId: 441,
      sessionTypeFormat: "IN_PERSON",
    });
    const run = await startLiveRun(service, {
      connectionId: configured.connectionId,
      idempotencyKey: "ambiguous-create-retry-contract",
    });
    const previewedSpeakers = await env.DB.prepare(
      `SELECT run_item.entity_id AS entityId, person.email
         FROM integration_run_items run_item
         JOIN people person ON person.id = run_item.entity_id
        WHERE run_item.run_id = ? AND run_item.entity_type = 'speaker'
        ORDER BY run_item.entity_id`,
    )
      .bind(run.runId)
      .all<{ entityId: string; email: string }>();
    expect(previewedSpeakers.results.length).toBeGreaterThan(1);
    const changedMappingSpeaker = previewedSpeakers.results[0]!;
    await env.DB.prepare(
      `INSERT INTO integration_entity_mappings (
         id, connection_id, entity_type, entity_id, external_id, source_hash,
         metadata_json, last_synced_at, created_at, updated_at
       ) VALUES (?, ?, 'speaker', ?, '999', ?, '{"payload":{}}',
                 unixepoch(), unixepoch(), unixepoch())`,
    )
      .bind(
        `changed-speaker-mapping-${crypto.randomUUID()}`,
        configured.connectionId,
        changedMappingSpeaker.entityId,
        "0".repeat(64),
      )
      .run();
    let failFirstSpeaker = true;
    const upsertSpeaker = vi.fn(async (payload: { email: string }) => {
      if (failFirstSpeaker) {
        failFirstSpeaker = false;
        throw new Error("The first speaker response was interrupted.");
      }
      return `speaker:${payload.email}`;
    });
    const dependencies = {
      createProvider: () => ({
        upsertSpeaker,
        createTrack: async (payload: { name: string }) =>
          `track:${payload.name}`,
        updateTrack: async (_payload: { name: string }, externalId: string) =>
          externalId,
        upsertSession: async (payload: { title: string }) =>
          `session:${payload.title}`,
        associateSessionSpeaker: async (sessionId: string, speakerId: string) =>
          `${sessionId}:${speakerId}`,
      }),
    };

    await processAcceleventsExport(queued.shift(), testEnv, dependencies);
    expect(
      upsertSpeaker.mock.calls.some(
        ([payload]) => payload.email === changedMappingSpeaker.email,
      ),
    ).toBe(false);
    await expect(
      env.DB.prepare(
        `SELECT status, error_message AS errorMessage
           FROM integration_run_items
          WHERE run_id = ? AND entity_type = 'speaker' AND entity_id = ?`,
      )
        .bind(run.runId, changedMappingSpeaker.entityId)
        .first(),
    ).resolves.toMatchObject({
      status: "failed",
      errorMessage: expect.stringMatching(/mapping changed after.*previewed/iu),
    });
    const failedSpeaker = await env.DB.prepare(
      `SELECT item.id
         FROM operation_items item
        WHERE item.operation_id = ? AND item.entity_type = 'speaker'
          AND item.status = 'failed'
          AND item.error_message LIKE '%response was interrupted%'
        ORDER BY item.entity_id LIMIT 1`,
    )
      .bind(run.operationId)
      .first<{ id: string }>();
    expect(failedSpeaker).not.toBeNull();
    const providerCallsAfterFirstAttempt = upsertSpeaker.mock.calls.length;

    await new OperationService(testEnv).retryItem(
      viewer,
      run.operationId!,
      failedSpeaker!.id,
    );
    await processAcceleventsExport(queued.shift(), testEnv, dependencies);

    expect(upsertSpeaker).toHaveBeenCalledTimes(providerCallsAfterFirstAttempt);
    await expect(
      env.DB.prepare(
        `SELECT status, error_message AS errorMessage
           FROM operation_items WHERE id = ? AND operation_id = ?`,
      )
        .bind(failedSpeaker!.id, run.operationId)
        .first(),
    ).resolves.toMatchObject({
      status: "failed",
      errorMessage: expect.stringMatching(
        /may already have reached Accelevents.*will not risk creating a duplicate/iu,
      ),
    });
  });

  it("stops provider writes when the connection is disconnected during a run", async () => {
    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment;
    const service = new IntegrationService(testEnv, {
      enqueue: async (message) => {
        queued.push(message);
      },
      createAccelevents: () => ({
        validateConnection: async () => undefined,
      }),
    });
    const configured = await service.configureAccelevents(viewer, {
      provider: "accelevents",
      apiKey: "disconnect-race-provider-key",
      eventUrl: "future-of-events",
      externalEventId: 441,
      sessionTypeFormat: "IN_PERSON",
    });
    await startLiveRun(service, {
      connectionId: configured.connectionId,
      idempotencyKey: `disconnect-run-${crypto.randomUUID()}`,
    });
    let providerCalls = 0;
    const write = async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        await service.disconnect(viewer, configured.connectionId);
      }
      return `external-${providerCalls}`;
    };

    await expect(
      processAcceleventsExport(queued.shift(), testEnv, {
        createProvider: () => ({
          upsertSpeaker: write,
          createTrack: write,
          updateTrack: write,
          upsertSession: write,
          associateSessionSpeaker: write,
        }),
      }),
    ).rejects.toThrow(
      "Accelevents connection was disconnected or changed before provider delivery",
    );
    expect(providerCalls).toBe(1);
    await expect(
      env.DB.prepare(
        "SELECT status, encrypted_credentials AS credentials FROM integration_connections WHERE id = ?",
      )
        .bind(configured.connectionId)
        .first(),
    ).resolves.toEqual({ status: "disconnected", credentials: null });
  });

  it("refuses to disconnect the authoritative Airtable repository", async () => {
    const connectionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE events SET repository_provider = 'airtable'
          WHERE id = ? AND organisation_id = ?`,
      ).bind(viewer.eventId, viewer.organisationId),
      env.DB.prepare(
        `INSERT INTO integration_connections (
           id, organisation_id, event_id, provider, status, direction,
           conflict_policy, encrypted_credentials, configuration_json,
           revision, created_at, updated_at
         ) VALUES (?, ?, ?, 'airtable_repository', 'connected', 'bidirectional',
                   'single_authority_no_dual_write', 'encrypted-test-value', '{}',
                   1, unixepoch(), unixepoch())`,
      ).bind(connectionId, viewer.organisationId, viewer.eventId),
    ]);
    const service = new IntegrationService(
      env as unknown as CloudflareEnvironment,
    );

    await expect(service.disconnect(viewer, connectionId)).rejects.toThrow(
      /migrate event-data authority back to D1/iu,
    );
    await expect(
      env.DB.prepare(
        `SELECT status, encrypted_credentials AS credentials
           FROM integration_connections WHERE id = ?`,
      )
        .bind(connectionId)
        .first(),
    ).resolves.toEqual({
      status: "connected",
      credentials: "encrypted-test-value",
    });
    await env.DB.prepare(
      `UPDATE events SET repository_provider = 'd1'
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .run();
  });
});
