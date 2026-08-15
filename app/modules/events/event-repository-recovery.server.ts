import { airtableConnectionInputSchema } from "~/modules/airtable/airtable-schema";
import { AIRTABLE_REPOSITORY_PROVIDER } from "~/modules/airtable/airtable-room-repository.server";
import {
  EventCreationLeaseStateError,
  EventCreationService,
} from "~/modules/events/event-creation-service.server";
import {
  EVENT_CREATION_STALLED_CODE,
  EventRepositoryProvisioningService,
  type AirtableProvisioningRoom,
} from "~/modules/events/event-repository-provisioning.server";
import type { Viewer } from "~/platform/auth/authorize.server";

type RecoveryDependencies = {
  provisioning?: Pick<EventRepositoryProvisioningService, "provisionAirtable">;
};

type RecoverableEvent = {
  id: string;
  name: string;
  slug: string;
  activationStatus:
    "provisioning" | "active" | "provisioning_failed" | "discarded";
  repositoryProvider: "d1" | "airtable";
  lastOperationId: string | null;
  operationStatus: string | null;
  operationType: string | null;
  operationLeaseExpired: number | null;
  operationFailureCode: string | null;
  lastError: string | null;
};

export type IncompleteEventSummary = Pick<
  RecoverableEvent,
  "id" | "name" | "activationStatus" | "operationStatus" | "lastError"
>;

export class EventRepositoryRecoveryStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventRepositoryRecoveryStateError";
  }
}

export class EventRepositoryRecoveryService {
  private readonly provisioning;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: RecoveryDependencies = {},
  ) {
    this.provisioning =
      dependencies.provisioning ??
      new EventRepositoryProvisioningService(this.env);
  }

  private async assertOrganisationAuthority(viewer: Viewer, eventId: string) {
    const authorised = await this.env.DB.prepare(
      `SELECT 1
         FROM events event
         JOIN memberships membership
           ON membership.organisation_id = event.organisation_id
          AND membership.event_id IS NULL
          AND membership.person_id = ?
          AND membership.role IN ('owner','administrator')
          AND membership.accepted_at IS NOT NULL
          AND membership.revoked_at IS NULL
        WHERE event.id = ? AND event.organisation_id = ?`,
    )
      .bind(viewer.personId, eventId, viewer.organisationId)
      .first();
    if (!authorised)
      throw new Response(
        "Organisation owner or administrator access is required to recover an incomplete event.",
        { status: 403 },
      );
  }

  async listIncomplete(viewer: Viewer): Promise<IncompleteEventSummary[]> {
    const events = await this.env.DB.prepare(
      `SELECT event.id, event.name,
              event.activation_status AS activationStatus,
              operation.status AS operationStatus,
              operation.last_error AS lastError
         FROM events event
         LEFT JOIN operation_jobs operation
           ON operation.id = event.last_operation_id
          AND operation.organisation_id = event.organisation_id
        WHERE event.organisation_id = ?
          AND event.repository_provider = 'airtable'
          AND event.activation_status IN ('provisioning','provisioning_failed')
          AND EXISTS (
            SELECT 1 FROM memberships membership
             WHERE membership.organisation_id = event.organisation_id
               AND membership.event_id IS NULL
               AND membership.person_id = ?
               AND membership.role IN ('owner','administrator')
               AND membership.accepted_at IS NOT NULL
               AND membership.revoked_at IS NULL
          )
        ORDER BY event.updated_at DESC, event.name COLLATE NOCASE, event.id`,
    )
      .bind(viewer.organisationId, viewer.personId)
      .all<IncompleteEventSummary>();
    return events.results;
  }

  async inspect(viewer: Viewer, eventId: string): Promise<RecoverableEvent> {
    await this.assertOrganisationAuthority(viewer, eventId);
    const event = await this.env.DB.prepare(
      `SELECT event.id, event.name, event.slug,
              event.activation_status AS activationStatus,
              event.repository_provider AS repositoryProvider,
              event.last_operation_id AS lastOperationId,
              operation.status AS operationStatus, operation.type AS operationType,
              CASE WHEN operation.claim_expires_at IS NULL THEN NULL
                   WHEN operation.claim_expires_at <= unixepoch() THEN 1
                   ELSE 0 END AS operationLeaseExpired,
              json_extract(operation.result_json, '$.failureCode') AS operationFailureCode,
              operation.last_error AS lastError
         FROM events event
         LEFT JOIN operation_jobs operation
           ON operation.id = event.last_operation_id
          AND operation.organisation_id = event.organisation_id
        WHERE event.id = ? AND event.organisation_id = ?`,
    )
      .bind(eventId, viewer.organisationId)
      .first<RecoverableEvent>();
    if (!event)
      throw new Response("Incomplete event not found.", { status: 404 });
    return event;
  }

  async failStalledCreation(viewer: Viewer, eventId: string) {
    const event = await this.inspect(viewer, eventId);
    if (
      event.repositoryProvider !== "airtable" ||
      event.activationStatus !== "provisioning" ||
      event.operationType !== "event.create" ||
      event.operationStatus !== "running" ||
      event.operationLeaseExpired !== 1 ||
      !event.lastOperationId
    ) {
      throw new EventRepositoryRecoveryStateError(
        "Only an expired Airtable creation operation can enter recovery.",
      );
    }
    try {
      const result = await new EventCreationService(
        this.env,
      ).failStalledCreation(viewer, event.lastOperationId);
      if (result.eventId !== eventId) {
        throw new Error(
          "The stalled event-creation operation targeted a different event.",
        );
      }
      return result;
    } catch (error) {
      if (error instanceof EventCreationLeaseStateError) {
        throw new EventRepositoryRecoveryStateError(error.message);
      }
      throw error;
    }
  }

  private assertFailedAirtable(event: RecoverableEvent) {
    if (
      event.repositoryProvider !== "airtable" ||
      event.activationStatus !== "provisioning_failed"
    )
      throw new EventRepositoryRecoveryStateError(
        "Only a failed, inactive Airtable event can use this recovery action.",
      );
  }

  private async rooms(
    organisationId: string,
    eventId: string,
  ): Promise<AirtableProvisioningRoom[]> {
    const rows = await this.env.DB.prepare(
      `SELECT id, name, building, level, capacity,
              resources_json AS resourcesJson, position
         FROM rooms
        WHERE event_id = ? AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM events
             WHERE id = rooms.event_id AND organisation_id = ?
          )
        ORDER BY position, name COLLATE NOCASE, id`,
    )
      .bind(eventId, organisationId)
      .all<{
        id: string;
        name: string;
        building: string | null;
        level: string | null;
        capacity: number;
        resourcesJson: string;
        position: number;
      }>();
    return rows.results.map((room) => {
      let resources: unknown;
      try {
        resources = JSON.parse(room.resourcesJson);
      } catch {
        throw new EventRepositoryRecoveryStateError(
          `Room ${room.id} has invalid resource configuration.`,
        );
      }
      if (
        !Array.isArray(resources) ||
        resources.some((resource) => typeof resource !== "string")
      )
        throw new EventRepositoryRecoveryStateError(
          `Room ${room.id} has invalid resource configuration.`,
        );
      return { ...room, resources };
    });
  }

  async retryAirtable(viewer: Viewer, eventId: string, rawConnection: unknown) {
    const event = await this.inspect(viewer, eventId);
    this.assertFailedAirtable(event);
    if (event.operationFailureCode === EVENT_CREATION_STALLED_CODE) {
      throw new EventRepositoryRecoveryStateError(
        "Airtable cannot be retried after setup timed out, because the original attempt may still finish. Keep the event in Program Cue or discard it.",
      );
    }
    const connection = airtableConnectionInputSchema.parse(rawConnection);
    const rooms = await this.rooms(viewer.organisationId, eventId);
    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           progress_total, progress_completed, progress_failed, cancellable,
           started_at, created_at, updated_at
         ) SELECT ?, ?, ?, ?, 'event.repository.provision', ?, ?, 'running', ?,
                  1, 0, 0, 0, unixepoch(), unixepoch(), unixepoch()
            FROM events
           WHERE id = ? AND organisation_id = ?
             AND repository_provider = 'airtable'
             AND activation_status = 'provisioning_failed'`,
      ).bind(
        operationId,
        viewer.organisationId,
        eventId,
        viewer.personId,
        `event-repository-provision:${operationId}`,
        correlationId,
        JSON.stringify({
          type: "event.repository.provision",
          targetEventId: eventId,
          requestedRepositoryProvider: "airtable",
          previousOperationId: event.lastOperationId,
        }),
        eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE events
            SET activation_status = 'provisioning', revision = revision + 1,
                last_operation_id = ?,
                last_updated_by_person_id = ?, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND repository_provider = 'airtable'
            AND activation_status = 'provisioning_failed'
            AND EXISTS (
              SELECT 1 FROM operation_jobs
               WHERE id = ? AND organisation_id = ? AND event_id = ?
                 AND status = 'running'
                 AND type = 'event.repository.provision'
            )`,
      ).bind(
        operationId,
        viewer.personId,
        eventId,
        viewer.organisationId,
        operationId,
        viewer.organisationId,
        eventId,
      ),
    ]);
    if (results.some((result) => (result.meta.changes ?? 0) !== 1))
      throw new EventRepositoryRecoveryStateError(
        "The incomplete event changed before Airtable retry could begin.",
      );
    await this.provisioning.provisionAirtable(
      viewer,
      eventId,
      operationId,
      "repository_recovery",
      connection,
      rooms,
    );
    return { eventId, operationId, activationStatus: "active" as const };
  }

  async keepOnD1(viewer: Viewer, eventId: string) {
    const event = await this.inspect(viewer, eventId);
    this.assertFailedAirtable(event);
    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE events
            SET repository_provider = 'd1', activation_status = 'active',
                repository_locked_at = NULL, revision = revision + 1,
                last_operation_id = ?, last_updated_by_person_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND repository_provider = 'airtable'
            AND activation_status = 'provisioning_failed'`,
      ).bind(operationId, viewer.personId, eventId, viewer.organisationId),
      this.env.DB.prepare(
        `UPDATE integration_connections
            SET status = 'disconnected', encrypted_credentials = NULL,
                revision = revision + 1, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE organisation_id = ? AND event_id = ? AND provider = ?
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ?
                 AND repository_provider = 'd1'
                 AND activation_status = 'active'
                 AND last_operation_id = ?
            )`,
      ).bind(
        operationId,
        viewer.organisationId,
        eventId,
        AIRTABLE_REPOSITORY_PROVIDER,
        eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json, result_json,
           progress_total, progress_completed, progress_failed, cancellable,
           started_at, completed_at, created_at, updated_at
         ) SELECT ?, ?, ?, ?, 'event.repository.keep_d1', ?, ?, 'completed', ?, ?,
                  1, 1, 0, 0, unixepoch(), unixepoch(), unixepoch(), unixepoch()
            FROM events
           WHERE id = ? AND organisation_id = ?
             AND repository_provider = 'd1' AND activation_status = 'active'
             AND last_operation_id = ?`,
      ).bind(
        operationId,
        viewer.organisationId,
        eventId,
        viewer.personId,
        `event-repository-keep-d1:${operationId}`,
        correlationId,
        JSON.stringify({
          type: "event.repository.keep_d1",
          targetEventId: eventId,
          previousOperationId: event.lastOperationId,
        }),
        JSON.stringify({
          targetEventId: eventId,
          repositoryProvider: "d1",
        }),
        eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'event.repository.kept_on_d1',
                  'event', ?, ?, ?, unixepoch()
            FROM operation_jobs
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND status = 'completed'`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        eventId,
        viewer.personId,
        eventId,
        correlationId,
        JSON.stringify({ previousOperationId: event.lastOperationId }),
        operationId,
        viewer.organisationId,
        eventId,
      ),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[2]?.meta.changes ?? 0) !== 1 ||
      (results[3]?.meta.changes ?? 0) !== 1
    )
      throw new EventRepositoryRecoveryStateError(
        "This event changed before Program Cue could take over its data.",
      );
    return { eventId, operationId, activationStatus: "active" as const };
  }

  async discard(viewer: Viewer, eventId: string) {
    const event = await this.inspect(viewer, eventId);
    this.assertFailedAirtable(event);
    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    // Colons are excluded by the public-slug validator, so this internal
    // tombstone namespace cannot collide with a user-created event slug.
    const discardedSlug = `discarded:${eventId}`;
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE events
            SET activation_status = 'discarded', slug = ?,
                revision = revision + 1,
                last_operation_id = ?, last_updated_by_person_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND repository_provider = 'airtable'
            AND activation_status = 'provisioning_failed'`,
      ).bind(
        discardedSlug,
        operationId,
        viewer.personId,
        eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE integration_connections
            SET status = 'disconnected', encrypted_credentials = NULL,
                revision = revision + 1, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE organisation_id = ? AND event_id = ? AND provider = ?
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ?
                 AND activation_status = 'discarded'
                 AND last_operation_id = ?
            )`,
      ).bind(
        operationId,
        viewer.organisationId,
        eventId,
        AIRTABLE_REPOSITORY_PROVIDER,
        eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json, result_json,
           progress_total, progress_completed, progress_failed, cancellable,
           started_at, completed_at, created_at, updated_at
         ) SELECT ?, ?, ?, ?, 'event.repository.discard', ?, ?, 'completed', ?, ?,
                  1, 1, 0, 0, unixepoch(), unixepoch(), unixepoch(), unixepoch()
            FROM events
           WHERE id = ? AND organisation_id = ?
             AND activation_status = 'discarded' AND last_operation_id = ?`,
      ).bind(
        operationId,
        viewer.organisationId,
        eventId,
        viewer.personId,
        `event-repository-discard:${operationId}`,
        correlationId,
        JSON.stringify({
          type: "event.repository.discard",
          targetEventId: eventId,
          previousOperationId: event.lastOperationId,
          originalSlug: event.slug,
        }),
        JSON.stringify({ targetEventId: eventId, discarded: true }),
        eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'event.incomplete.discarded',
                  'event', ?, ?, ?, unixepoch()
            FROM operation_jobs
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND status = 'completed'`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        eventId,
        viewer.personId,
        eventId,
        correlationId,
        JSON.stringify({
          previousOperationId: event.lastOperationId,
          originalSlug: event.slug,
          providerArtifactsMayRemain: true,
        }),
        operationId,
        viewer.organisationId,
        eventId,
      ),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[2]?.meta.changes ?? 0) !== 1 ||
      (results[3]?.meta.changes ?? 0) !== 1
    )
      throw new EventRepositoryRecoveryStateError(
        "The incomplete event changed before it could be discarded.",
      );
    return { eventId, operationId, activationStatus: "discarded" as const };
  }
}
