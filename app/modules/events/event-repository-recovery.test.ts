import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AIRTABLE_REPOSITORY_PROVIDER,
  AirtableRepositoryConfigurationError,
  type PreparedAirtableRepositoryConnection,
} from "~/modules/airtable/airtable-room-repository.server";
import { AIRTABLE_SCHEMA_VERSION } from "~/modules/airtable/airtable-schema";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { EventRepositoryProvisioningService } from "./event-repository-provisioning.server";
import {
  EventRepositoryRecoveryService,
  EventRepositoryRecoveryStateError,
} from "./event-repository-recovery.server";

const testEnv = env as unknown as CloudflareEnvironment;
const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

async function failedEvent() {
  const eventId = `recovery-event-${crypto.randomUUID()}`;
  const operationId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const integrationRunId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         repository_provider, activation_status, file_policy_json,
         last_operation_id, last_updated_by_person_id
       ) VALUES (?, ?, 'Incomplete Airtable event', ?, 'UTC', 1800000000,
                 1800086400, 'airtable', 'provisioning_failed', ?, ?, ?)`,
    ).bind(
      eventId,
      viewer.organisationId,
      `incomplete-${eventId}`,
      CANONICAL_EVENT_FILE_POLICY_JSON,
      operationId,
      viewer.personId,
    ),
    env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         progress_total, progress_completed, progress_failed, cancellable,
         last_error, started_at, completed_at
       ) VALUES (?, ?, ?, ?, 'event.create', ?, ?, 'failed', ?,
                 1, 0, 1, 0, 'provider failed', unixepoch(), unixepoch())`,
    ).bind(
      operationId,
      viewer.organisationId,
      eventId,
      viewer.personId,
      `failed-create-${operationId}`,
      crypto.randomUUID(),
      JSON.stringify({
        type: "event.create",
        targetEventId: eventId,
        requestedRepositoryProvider: "airtable",
      }),
    ),
    env.DB.prepare(
      `INSERT INTO integration_connections (
         id, organisation_id, event_id, provider, status, direction,
         conflict_policy, encrypted_credentials, configuration_json,
         last_operation_id
       ) VALUES (?, ?, ?, ?, 'needs_attention', 'bidirectional',
                 'single_authority_no_dual_write', 'old-encrypted-value',
                 '{"baseId":"app-audit-evidence"}', ?)`,
    ).bind(
      connectionId,
      viewer.organisationId,
      eventId,
      AIRTABLE_REPOSITORY_PROVIDER,
      operationId,
    ),
    env.DB.prepare(
      `INSERT INTO integration_runs (
         id, connection_id, idempotency_key, status, direction, dry_run,
         summary_json, started_at, completed_at
       ) VALUES (?, ?, ?, 'failed', 'outbound', 0, '{}',
                 unixepoch(), unixepoch())`,
    ).bind(
      integrationRunId,
      connectionId,
      `failed-integration-run-${integrationRunId}`,
    ),
  ]);
  return {
    eventId,
    operationId,
    connectionId,
    integrationRunId,
    slug: `incomplete-${eventId}`,
  };
}

function preparedConnection(
  connectionId: string = crypto.randomUUID(),
): PreparedAirtableRepositoryConnection {
  return {
    connectionId,
    encryptedCredentials: '{"version":1,"iv":"retry","ciphertext":"retry"}',
    configuration: {
      baseId: "app12345678901234",
      schemaVersion: AIRTABLE_SCHEMA_VERSION,
      tables:
        {} as PreparedAirtableRepositoryConnection["configuration"]["tables"],
      authoritativeEntities: [
        "rooms",
        "event_configuration",
        "forms",
        "submissions",
        "evaluations",
        "sessions",
        "tasks",
        "published_programme",
      ],
    },
  };
}

describe("incomplete event repository recovery", () => {
  beforeEach(async () => {
    await ensureDemoData(testEnv);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO memberships (
         id, organisation_id, event_id, person_id, role,
         invited_at, accepted_at, created_at
       ) VALUES ('membership-recovery-org-admin', ?, NULL, ?,
                 'administrator', unixepoch(), unixepoch(), unixepoch())`,
    )
      .bind(viewer.organisationId, viewer.personId)
      .run();
  });

  it("lists incomplete events only for organisation-wide administrators", async () => {
    const target = await failedEvent();
    const service = new EventRepositoryRecoveryService(testEnv);

    await expect(service.listIncomplete(viewer)).resolves.toContainEqual({
      id: target.eventId,
      name: "Incomplete Airtable event",
      activationStatus: "provisioning_failed",
      operationStatus: "failed",
      lastError: "provider failed",
    });

    await env.DB.prepare(
      "DELETE FROM memberships WHERE id = 'membership-recovery-org-admin'",
    ).run();
    await expect(service.listIncomplete(viewer)).resolves.toEqual([]);
  });

  it("moves an expired blank creation to explicit recovery without provider work", async () => {
    const eventId = `stalled-recovery-${crypto.randomUUID()}`;
    const operationId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           repository_provider, activation_status, file_policy_json,
           last_operation_id, last_updated_by_person_id
         ) VALUES (?, ?, 'Stalled Airtable event', ?, 'UTC', 1800000000,
                   1800086400, 'airtable', 'provisioning', ?, ?, ?)`,
      ).bind(
        eventId,
        viewer.organisationId,
        `stalled-${eventId}`,
        CANONICAL_EVENT_FILE_POLICY_JSON,
        operationId,
        viewer.personId,
      ),
      env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           progress_total, progress_completed, progress_failed, cancellable,
           claim_expires_at, started_at
         ) VALUES (?, ?, ?, ?, 'event.create', ?, ?, 'running', ?,
                   1, 0, 0, 0, unixepoch() - 1, unixepoch() - 901)`,
      ).bind(
        operationId,
        viewer.organisationId,
        eventId,
        viewer.personId,
        `stalled-create-${operationId}`,
        operationId,
        JSON.stringify({
          type: "event.create",
          targetEventId: eventId,
          requestedRepositoryProvider: "airtable",
          requestHash: "a".repeat(64),
        }),
      ),
    ]);
    const service = new EventRepositoryRecoveryService(testEnv);

    await expect(service.inspect(viewer, eventId)).resolves.toMatchObject({
      operationType: "event.create",
      operationStatus: "running",
      operationLeaseExpired: 1,
    });
    await expect(service.failStalledCreation(viewer, eventId)).resolves.toEqual(
      {
        eventId,
        operationId,
        activationStatus: "provisioning_failed",
      },
    );
    await expect(service.inspect(viewer, eventId)).resolves.toMatchObject({
      activationStatus: "provisioning_failed",
      operationStatus: "failed",
      operationLeaseExpired: null,
      operationFailureCode: "event_creation_lease_expired",
    });
    await expect(service.retryAirtable(viewer, eventId, {})).rejects.toThrow(
      /Airtable cannot be retried after setup timed out/iu,
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM operation_jobs WHERE event_id = ?",
      )
        .bind(eventId)
        .first(),
    ).toEqual({ count: 1 });
    await expect(
      service.failStalledCreation(viewer, eventId),
    ).rejects.toBeInstanceOf(EventRepositoryRecoveryStateError);
  });

  it("retries Airtable through a fresh durable operation and activates only after reconciliation", async () => {
    const target = await failedEvent();
    const provisioning = new EventRepositoryProvisioningService(testEnv, {
      rooms: {
        provisionForEvent: async (_viewer, _eventId, _connection, options) =>
          preparedConnection(options?.connectionId),
        replaceRooms: async () => ({ rooms: [] }) as never,
      },
      eventData: {
        synchronizeFromD1: async () => ({
          runId: "retry-initial-sync",
          idempotent: false,
        }),
      },
    });
    const result = await new EventRepositoryRecoveryService(testEnv, {
      provisioning,
    }).retryAirtable(viewer, target.eventId, {
      personalAccessToken: "pat-test-token-at-least-twenty",
      baseId: "app12345678901234",
      tableName: "Program Cue Rooms",
    });

    expect(result.activationStatus).toBe("active");
    expect(
      await env.DB.prepare(
        `SELECT repository_provider AS provider, revision,
                activation_status AS activationStatus,
                last_operation_id AS operationId
           FROM events WHERE id = ?`,
      )
        .bind(target.eventId)
        .first(),
    ).toEqual({
      provider: "airtable",
      revision: 3,
      activationStatus: "active",
      operationId: result.operationId,
    });
    expect(
      await env.DB.prepare(
        "SELECT type, status FROM operation_jobs WHERE id = ?",
      )
        .bind(result.operationId)
        .first(),
    ).toEqual({ type: "event.repository.provision", status: "completed" });
    expect(
      await env.DB.prepare(
        `SELECT id, status, revision FROM integration_connections
          WHERE event_id = ? AND provider = ?`,
      )
        .bind(target.eventId, AIRTABLE_REPOSITORY_PROVIDER)
        .first(),
    ).toEqual({ id: target.connectionId, status: "connected", revision: 2 });
    expect(
      await env.DB.prepare("SELECT status FROM integration_runs WHERE id = ?")
        .bind(target.integrationRunId)
        .first(),
    ).toEqual({ status: "failed" });
  });

  it("activates D1 only after an explicit keep decision and clears saved credentials", async () => {
    const target = await failedEvent();
    const result = await new EventRepositoryRecoveryService(testEnv).keepOnD1(
      viewer,
      target.eventId,
    );

    expect(
      await env.DB.prepare(
        `SELECT repository_provider AS provider, revision,
                activation_status AS activationStatus, slug
           FROM events WHERE id = ?`,
      )
        .bind(target.eventId)
        .first(),
    ).toEqual({
      provider: "d1",
      revision: 2,
      activationStatus: "active",
      slug: target.slug,
    });
    expect(
      await env.DB.prepare(
        `SELECT status, encrypted_credentials AS credentials,
                configuration_json AS configurationJson,
                revision, last_operation_id AS operationId
           FROM integration_connections WHERE event_id = ?`,
      )
        .bind(target.eventId)
        .first(),
    ).toEqual({
      status: "disconnected",
      credentials: null,
      configurationJson: '{"baseId":"app-audit-evidence"}',
      revision: 2,
      operationId: result.operationId,
    });
    expect(result.activationStatus).toBe("active");
  });

  it("discards to an inaccessible tombstone, releases the slug, and preserves audit evidence", async () => {
    const target = await failedEvent();
    const result = await new EventRepositoryRecoveryService(testEnv).discard(
      viewer,
      target.eventId,
    );

    expect(
      await env.DB.prepare(
        `SELECT activation_status AS activationStatus, revision, slug
           FROM events WHERE id = ?`,
      )
        .bind(target.eventId)
        .first(),
    ).toEqual({
      activationStatus: "discarded",
      revision: 2,
      slug: `discarded:${target.eventId}`,
    });
    expect(
      await env.DB.prepare("SELECT 1 FROM events WHERE slug = ?")
        .bind(target.slug)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT action FROM audit_events
          WHERE event_id = ? AND action = 'event.incomplete.discarded'`,
      )
        .bind(target.eventId)
        .first(),
    ).toEqual({ action: "event.incomplete.discarded" });
    expect(result.activationStatus).toBe("discarded");
  });

  it("returns a failed inactive state when an Airtable retry is rejected", async () => {
    const target = await failedEvent();
    const provisioning = new EventRepositoryProvisioningService(testEnv, {
      rooms: {
        provisionForEvent: async () => {
          throw new AirtableRepositoryConfigurationError(
            "The replacement Airtable credentials were rejected.",
          );
        },
        replaceRooms: async () => ({ rooms: [] }) as never,
      },
      eventData: {
        synchronizeFromD1: async () => ({
          runId: "unexpected-retry-sync",
          idempotent: false,
        }),
      },
    });

    await expect(
      new EventRepositoryRecoveryService(testEnv, {
        provisioning,
      }).retryAirtable(viewer, target.eventId, {
        personalAccessToken: "pat-test-token-at-least-twenty",
        baseId: "app12345678901234",
        tableName: "Program Cue Rooms",
      }),
    ).rejects.toMatchObject({ failureKind: "provider" });

    const event = await env.DB.prepare(
      `SELECT activation_status AS activationStatus, revision,
              last_operation_id AS operationId
         FROM events WHERE id = ?`,
    )
      .bind(target.eventId)
      .first<{
        activationStatus: string;
        revision: number;
        operationId: string;
      }>();
    expect(event).toMatchObject({
      activationStatus: "provisioning_failed",
      revision: 3,
    });
    expect(
      await env.DB.prepare(
        `SELECT status, last_error AS lastError
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(event!.operationId)
        .first(),
    ).toEqual({
      status: "failed",
      lastError: "The replacement Airtable credentials were rejected.",
    });
  });

  it("does not let a stale provisioning attempt call Airtable or fail a newer attempt", async () => {
    const target = await failedEvent();
    const newerOperationId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           progress_total, cancellable, started_at
         ) VALUES (?, ?, ?, ?, 'event.repository.provision', ?, ?, 'running', ?,
                   1, 0, unixepoch())`,
      ).bind(
        newerOperationId,
        viewer.organisationId,
        target.eventId,
        viewer.personId,
        `newer-retry-${newerOperationId}`,
        crypto.randomUUID(),
        JSON.stringify({
          type: "event.repository.provision",
          targetEventId: target.eventId,
          requestedRepositoryProvider: "airtable",
        }),
      ),
      env.DB.prepare(
        `UPDATE events
            SET activation_status = 'provisioning', last_operation_id = ?
          WHERE id = ? AND organisation_id = ?`,
      ).bind(newerOperationId, target.eventId, viewer.organisationId),
    ]);
    let providerCalled = false;
    const provisioning = new EventRepositoryProvisioningService(testEnv, {
      rooms: {
        provisionForEvent: async () => {
          providerCalled = true;
          return preparedConnection();
        },
        replaceRooms: async () => ({ rooms: [] }) as never,
      },
      eventData: {
        synchronizeFromD1: async () => ({
          runId: "unexpected-stale-sync",
          idempotent: false,
        }),
      },
    });

    await expect(
      provisioning.provisionAirtable(
        viewer,
        target.eventId,
        target.operationId,
        "repository_recovery",
        {},
        [],
      ),
    ).rejects.toThrow(/no longer the current event operation/i);

    expect(providerCalled).toBe(false);
    expect(
      await env.DB.prepare(
        `SELECT activation_status AS activationStatus,
                last_operation_id AS operationId
           FROM events WHERE id = ?`,
      )
        .bind(target.eventId)
        .first(),
    ).toEqual({
      activationStatus: "provisioning",
      operationId: newerOperationId,
    });
    expect(
      await env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
        .bind(newerOperationId)
        .first(),
    ).toEqual({ status: "running" });
  });
});
