import { AirtableEventDataRepository } from "~/modules/airtable/airtable-event-data-repository.server";
import {
  AIRTABLE_REPOSITORY_PROVIDER,
  AirtableRoomRepository,
  isAirtableRepositoryError,
  type PreparedAirtableRepositoryConnection,
} from "~/modules/airtable/airtable-room-repository.server";
import type { Viewer } from "~/platform/auth/authorize.server";

export type AirtableProvisioningRoom = {
  id: string;
  name: string;
  building?: string | null;
  level?: string | null;
  capacity: number;
  resources: string[];
  position: number;
};

export const EVENT_CREATION_STALLED_CODE = "event_creation_lease_expired";
export const EVENT_CREATION_STALLED_MESSAGE =
  "Event creation stopped before Airtable provisioning recorded a terminal result. The incomplete event is unavailable until you recover or discard it.";

type EventRepositoryProvisioningDependencies = {
  rooms?: Pick<AirtableRoomRepository, "provisionForEvent" | "replaceRooms">;
  eventData?: Pick<AirtableEventDataRepository, "synchronizeFromD1">;
};

export class EventRepositoryProvisioningError extends Error {
  readonly committed = true;

  constructor(
    message: string,
    readonly eventId: string,
    readonly operationId: string,
    readonly failureKind: "provider" | "internal",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EventRepositoryProvisioningError";
  }
}

export function eventRepositoryProvisioningFailureMessage(
  failureKind: "provider" | "internal",
) {
  return failureKind === "provider"
    ? "Airtable provisioning did not complete. The incomplete event is unavailable until you retry Airtable, explicitly keep it on D1, or discard it."
    : "Repository finalization failed unexpectedly. The incomplete event is unavailable until you recover or discard it.";
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2_000,
  );
}

export class EventRepositoryProvisioningService {
  private readonly rooms;
  private readonly eventData;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: EventRepositoryProvisioningDependencies = {},
  ) {
    this.rooms = dependencies.rooms ?? new AirtableRoomRepository(env);
    this.eventData =
      dependencies.eventData ??
      new AirtableEventDataRepository(env, {
        rooms: this.rooms as AirtableRoomRepository,
      });
  }

  private async isCurrentOperation(
    viewer: Viewer,
    eventId: string,
    operationId: string,
  ) {
    return Boolean(
      await this.env.DB.prepare(
        `SELECT 1
           FROM events event
           JOIN operation_jobs operation ON operation.id = ?
          WHERE event.id = ? AND event.organisation_id = ?
            AND event.repository_provider = 'airtable'
            AND event.activation_status = 'provisioning'
            AND event.last_operation_id = operation.id
            AND operation.organisation_id = event.organisation_id
            AND operation.status = 'running'
            AND operation.type IN (
              'event.create','event.clone','event.repository.provision'
            )
            AND (
              operation.type <> 'event.create'
              OR (
                operation.claim_expires_at IS NOT NULL
                AND operation.claim_expires_at > unixepoch()
              )
            )
            AND json_extract(operation.payload_json, '$.targetEventId') = event.id`,
      )
        .bind(operationId, eventId, viewer.organisationId)
        .first(),
    );
  }

  private async assertCurrentOperation(
    viewer: Viewer,
    eventId: string,
    operationId: string,
  ) {
    if (!(await this.isCurrentOperation(viewer, eventId, operationId))) {
      throw new Error(
        "Airtable provisioning is no longer the current event operation.",
      );
    }
  }

  private connectionInsert(
    viewer: Viewer,
    eventId: string,
    operationId: string,
    prepared: PreparedAirtableRepositoryConnection,
  ) {
    return this.env.DB.prepare(
      `INSERT INTO integration_connections (
         id, organisation_id, event_id, provider, status, direction,
         conflict_policy, encrypted_credentials, configuration_json,
         revision, last_operation_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'connected', 'bidirectional',
                 'single_authority_no_dual_write', ?, ?, 1, ?,
                 unixepoch(), unixepoch())
       ON CONFLICT(id) DO UPDATE SET
         status = 'connected', direction = 'bidirectional',
         conflict_policy = 'single_authority_no_dual_write',
         encrypted_credentials = excluded.encrypted_credentials,
         configuration_json = excluded.configuration_json,
         revision = integration_connections.revision + 1,
         last_operation_id = excluded.last_operation_id,
         updated_at = unixepoch()
       WHERE integration_connections.organisation_id = excluded.organisation_id
         AND integration_connections.event_id = excluded.event_id
         AND integration_connections.provider = excluded.provider
         AND integration_connections.status IN (
           'needs_attention','failed','disconnected'
         )`,
    ).bind(
      prepared.connectionId,
      viewer.organisationId,
      eventId,
      AIRTABLE_REPOSITORY_PROVIDER,
      prepared.encryptedCredentials,
      JSON.stringify(prepared.configuration),
      operationId,
    );
  }

  private connectionAuditInsert(
    viewer: Viewer,
    eventId: string,
    operationId: string,
    prepared: PreparedAirtableRepositoryConnection,
  ) {
    return this.env.DB.prepare(
      `INSERT INTO audit_events (
         id, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, correlation_id, metadata_json, created_at
       ) SELECT ?, ?, ?, ?, 'airtable.repository.configured',
                  'integration_connection', ?, ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM integration_connections
             WHERE id = ? AND organisation_id = ? AND event_id = ?
               AND provider = ? AND status = 'connected'
               AND last_operation_id = ?
          )`,
    ).bind(
      crypto.randomUUID(),
      viewer.organisationId,
      eventId,
      viewer.personId,
      prepared.connectionId,
      operationId,
      JSON.stringify({
        baseId: prepared.configuration.baseId,
        tables: prepared.configuration.tables,
        schemaVersion: prepared.configuration.schemaVersion,
        authoritativeEntities: prepared.configuration.authoritativeEntities,
      }),
      prepared.connectionId,
      viewer.organisationId,
      eventId,
      AIRTABLE_REPOSITORY_PROVIDER,
      operationId,
    );
  }

  async provisionAirtable(
    viewer: Viewer,
    eventId: string,
    operationId: string,
    workflow: "blank_event_creation" | "event_clone" | "repository_recovery",
    rawConnection: unknown,
    rooms: AirtableProvisioningRoom[],
    result: Record<string, unknown> = {},
  ) {
    if (!(await this.isCurrentOperation(viewer, eventId, operationId)))
      throw new EventRepositoryProvisioningError(
        "Airtable provisioning is no longer the current event operation. No provider request was made.",
        eventId,
        operationId,
        "internal",
      );

    try {
      const existing = await this.env.DB.prepare(
        `SELECT id FROM integration_connections
          WHERE organisation_id = ? AND event_id = ? AND provider = ?
            AND status IN ('needs_attention','failed','disconnected')`,
      )
        .bind(viewer.organisationId, eventId, AIRTABLE_REPOSITORY_PROVIDER)
        .first<{ id: string }>();
      const prepared = await this.rooms.provisionForEvent(
        viewer,
        eventId,
        rawConnection,
        { connectionId: existing?.id },
      );
      await this.assertCurrentOperation(viewer, eventId, operationId);
      const connectionResults = await this.env.DB.batch([
        this.connectionInsert(viewer, eventId, operationId, prepared),
        this.connectionAuditInsert(viewer, eventId, operationId, prepared),
      ]);
      if (
        (connectionResults[0]?.meta.changes ?? 0) !== 1 ||
        (connectionResults[1]?.meta.changes ?? 0) !== 1
      )
        throw new Error(
          "The validated Airtable connection could not be recorded completely.",
        );

      await this.assertCurrentOperation(viewer, eventId, operationId);
      await this.rooms.replaceRooms(viewer.organisationId, eventId, rooms, 1);
      await this.assertCurrentOperation(viewer, eventId, operationId);
      const synchronization = await this.eventData.synchronizeFromD1(
        {
          organisationId: viewer.organisationId,
          eventId,
          personId: viewer.personId,
        },
        {
          idempotencyKey: `event-provisioning:${operationId}`,
          reason: workflow,
        },
      );
      await this.assertCurrentOperation(viewer, eventId, operationId);
      const statements: D1PreparedStatement[] = [
        this.env.DB.prepare(
          `UPDATE events
              SET activation_status = 'active',
                  repository_locked_at = unixepoch(),
                  revision = revision + 1, last_operation_id = ?,
                  last_updated_by_person_id = ?, updated_at = unixepoch()
            WHERE id = ? AND organisation_id = ?
              AND repository_provider = 'airtable'
              AND activation_status = 'provisioning'
              AND repository_locked_at IS NULL
              AND last_operation_id = ?
              AND EXISTS (
                SELECT 1 FROM operation_jobs operation
                 WHERE operation.id = ?
                   AND operation.organisation_id = ?
                   AND operation.status = 'running'
                   AND operation.type IN (
                     'event.create','event.clone','event.repository.provision'
                   )
                   AND (
                     operation.type <> 'event.create'
                     OR (
                       operation.claim_expires_at IS NOT NULL
                       AND operation.claim_expires_at > unixepoch()
                     )
                   )
                   AND json_extract(operation.payload_json, '$.targetEventId') = ?
              )`,
        ).bind(
          operationId,
          viewer.personId,
          eventId,
          viewer.organisationId,
          operationId,
          operationId,
          viewer.organisationId,
          eventId,
        ),
        this.env.DB.prepare(
          `UPDATE operation_jobs
              SET status = 'completed', progress_completed = progress_total,
                  result_json = ?, claim_token = NULL,
                  claim_expires_at = NULL, completed_at = unixepoch(),
                  updated_at = unixepoch()
            WHERE id = ? AND organisation_id = ?
              AND status = 'running'
              AND type IN (
                'event.create','event.clone','event.repository.provision'
              )
              AND (
                type <> 'event.create'
                OR (
                  claim_expires_at IS NOT NULL
                  AND claim_expires_at > unixepoch()
                )
              )
              AND json_extract(payload_json, '$.targetEventId') = ?
              AND EXISTS (
                SELECT 1 FROM events event
                 WHERE event.id = ? AND event.organisation_id = ?
                   AND event.repository_provider = 'airtable'
                   AND event.activation_status = 'active'
                   AND event.last_operation_id = ?
              )`,
        ).bind(
          JSON.stringify({
            ...result,
            targetEventId: eventId,
            repositoryProvider: "airtable",
            synchronizationRunId: synchronization.runId,
          }),
          operationId,
          viewer.organisationId,
          eventId,
          eventId,
          viewer.organisationId,
          operationId,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           ) SELECT ?, ?, ?, ?, 'event.repository.selected',
                    'event', ?, ?, ?, unixepoch()
              WHERE EXISTS (
                SELECT 1
                  FROM events event
                  JOIN operation_jobs operation ON operation.id = ?
                 WHERE event.id = ? AND event.organisation_id = ?
                   AND event.repository_provider = 'airtable'
                   AND event.last_operation_id = ?
                   AND operation.organisation_id = ?
                   AND operation.status = 'completed'
                   AND operation.type IN (
                     'event.create','event.clone','event.repository.provision'
                   )
                   AND json_extract(operation.payload_json, '$.targetEventId') = ?
              )`,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          eventId,
          viewer.personId,
          eventId,
          operationId,
          JSON.stringify({
            repositoryProvider: "airtable",
            synchronizationRunId: synchronization.runId,
          }),
          operationId,
          eventId,
          viewer.organisationId,
          operationId,
          viewer.organisationId,
          eventId,
        ),
      ];
      const results = await this.env.DB.batch(statements);
      if (results.some((result) => (result.meta.changes ?? 0) !== 1))
        throw new Error(
          "Airtable synchronized, but the event authority switch did not commit completely.",
        );
      return synchronization;
    } catch (error) {
      const message = boundedError(error);
      const failureKind = isAirtableRepositoryError(error)
        ? "provider"
        : "internal";
      const expiredCreationResult = JSON.stringify({
        targetEventId: eventId,
        repositoryProvider: "airtable",
        failureKind: "internal",
        failureCode: EVENT_CREATION_STALLED_CODE,
      });
      const failureResult = JSON.stringify({
        targetEventId: eventId,
        repositoryProvider: "airtable",
        failureKind,
      });
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE events
              SET activation_status = 'provisioning_failed',
                  revision = revision + 1,
                  updated_at = unixepoch()
            WHERE id = ? AND organisation_id = ?
              AND repository_provider = 'airtable'
              AND activation_status = 'provisioning'
              AND last_operation_id = ?`,
        ).bind(eventId, viewer.organisationId, operationId),
        this.env.DB.prepare(
          `UPDATE operation_jobs
              SET status = 'failed', progress_failed = progress_total,
                  result_json = CASE
                    WHEN type = 'event.create'
                     AND claim_expires_at IS NOT NULL
                     AND claim_expires_at <= unixepoch() THEN ?
                    WHEN type = 'event.create' THEN ?
                    ELSE result_json END,
                  last_error = ?, claim_token = NULL,
                  claim_expires_at = NULL, completed_at = unixepoch(),
                  updated_at = unixepoch()
            WHERE id = ? AND organisation_id = ?
              AND status = 'running'
              AND type IN (
                'event.create','event.clone','event.repository.provision'
              )
              AND json_extract(payload_json, '$.targetEventId') = ?`,
        ).bind(
          expiredCreationResult,
          failureResult,
          message,
          operationId,
          viewer.organisationId,
          eventId,
        ),
        this.env.DB.prepare(
          `UPDATE integration_connections
              SET status = 'needs_attention', revision = revision + 1,
                  updated_at = unixepoch()
            WHERE organisation_id = ? AND event_id = ?
              AND provider = ? AND last_operation_id = ?
              AND status = 'connected'`,
        ).bind(
          viewer.organisationId,
          eventId,
          AIRTABLE_REPOSITORY_PROVIDER,
          operationId,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           ) SELECT ?, ?, ?, ?, 'event.repository.provisioning_failed',
                    'event', ?, ?, ?, unixepoch()
              WHERE EXISTS (
                SELECT 1
                  FROM operation_jobs operation
                  JOIN events event ON event.id = ?
                 WHERE operation.id = ?
                   AND operation.organisation_id = ?
                   AND operation.status = 'failed'
                   AND operation.type IN (
                     'event.create','event.clone','event.repository.provision'
                   )
                   AND json_extract(operation.payload_json, '$.targetEventId') = event.id
                   AND event.organisation_id = operation.organisation_id
                   AND event.activation_status = 'provisioning_failed'
                   AND event.last_operation_id = operation.id
              )
                AND NOT EXISTS (
                  SELECT 1 FROM audit_events existing
                   WHERE existing.organisation_id = ?
                     AND existing.event_id = ?
                     AND existing.action = 'event.repository.provisioning_failed'
                     AND existing.correlation_id = ?
                )`,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          eventId,
          viewer.personId,
          eventId,
          operationId,
          JSON.stringify({
            operationId,
            requestedRepositoryProvider: "airtable",
            observedFailureKind: failureKind,
            errorName: error instanceof Error ? error.name : "UnknownError",
          }),
          eventId,
          operationId,
          viewer.organisationId,
          viewer.organisationId,
          eventId,
          operationId,
        ),
      ]);
      const terminal = await this.env.DB.prepare(
        `SELECT json_extract(result_json, '$.failureCode') = ? AS leaseExpired
           FROM operation_jobs
          WHERE id = ? AND organisation_id = ? AND event_id = ?`,
      )
        .bind(
          EVENT_CREATION_STALLED_CODE,
          operationId,
          viewer.organisationId,
          eventId,
        )
        .first<{ leaseExpired: number | null }>();
      const terminalFailureKind = terminal?.leaseExpired ? "internal" : failureKind;
      throw new EventRepositoryProvisioningError(
        terminal?.leaseExpired
          ? EVENT_CREATION_STALLED_MESSAGE
          : eventRepositoryProvisioningFailureMessage(terminalFailureKind),
        eventId,
        operationId,
        terminalFailureKind,
        { cause: error },
      );
    }
  }
}
