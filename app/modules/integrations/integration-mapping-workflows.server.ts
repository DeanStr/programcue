import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import { IntegrationConnectionWorkflows } from "./integration-connection-workflows.server";
import {
  IntegrationStateError,
  integrationMappingInputSchema,
} from "./integration-service-foundation.server";

export abstract class IntegrationMappingWorkflows extends IntegrationConnectionWorkflows {
  protected async assertMappingEntity(
    viewer: Viewer,
    input: z.infer<typeof integrationMappingInputSchema>,
  ) {
    const queries = {
      speaker:
        "SELECT 1 FROM people person WHERE person.id = ? AND EXISTS (SELECT 1 FROM session_speakers speaker WHERE speaker.event_id = ? AND speaker.person_id = person.id)",
      track: "SELECT 1 FROM tracks WHERE id = ? AND event_id = ?",
      session: "SELECT 1 FROM sessions WHERE id = ? AND event_id = ?",
      session_speaker:
        "SELECT 1 FROM session_speakers WHERE event_id = ? AND session_id || ':' || person_id = ?",
    } satisfies Record<typeof input.entityType, string>;
    const entity = await this.env.DB.prepare(queries[input.entityType])
      .bind(
        ...(input.entityType === "session_speaker"
          ? [viewer.eventId, input.entityId]
          : [input.entityId, viewer.eventId]),
      )
      .first();
    if (!entity) {
      throw new IntegrationStateError(
        "The mapping target does not exist in this event.",
      );
    }
  }

  async saveMapping(
    viewer: Viewer,
    connectionId: string,
    raw: unknown,
    operationId: string = crypto.randomUUID(),
  ) {
    this.assertAdministrator(viewer);
    const input = integrationMappingInputSchema.parse(raw);
    const connection = await this.env.DB.prepare(
      `SELECT id FROM integration_connections
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND status = 'connected'`,
    )
      .bind(connectionId, viewer.eventId, viewer.organisationId)
      .first();
    if (!connection) {
      throw new IntegrationStateError(
        "Connect this integration before saving mappings.",
      );
    }
    const recovered = await this.env.DB.prepare(
      `SELECT id FROM integration_entity_mappings
        WHERE connection_id = ? AND entity_type = ? AND entity_id = ?
          AND external_id = ? AND source_hash = ? AND last_operation_id = ?`,
    )
      .bind(
        connectionId,
        input.entityType,
        input.entityId,
        input.externalId,
        input.sourceHash,
        operationId,
      )
      .first<{ id: string }>();
    if (recovered) return { mappingId: recovered.id };
    await this.assertMappingEntity(viewer, input);
    const current = await this.env.DB.prepare(
      `SELECT id FROM integration_entity_mappings
        WHERE connection_id = ? AND entity_type = ? AND entity_id = ?`,
    )
      .bind(connectionId, input.entityType, input.entityId)
      .first<{ id: string }>();
    const mappingId = current?.id ?? operationId;
    try {
      const [saved] = await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO integration_entity_mappings (
             id, connection_id, entity_type, entity_id, external_id,
             source_hash, metadata_json, last_operation_id,
             last_synced_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch(), unixepoch())
           ON CONFLICT(connection_id, entity_type, entity_id) DO UPDATE SET
             external_id = excluded.external_id,
             source_hash = excluded.source_hash,
             metadata_json = excluded.metadata_json,
             last_operation_id = excluded.last_operation_id,
             last_synced_at = unixepoch(), updated_at = unixepoch()`,
        ).bind(
          mappingId,
          connectionId,
          input.entityType,
          input.entityId,
          input.externalId,
          input.sourceHash,
          JSON.stringify(input.metadata),
          operationId,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'integration.mapping.saved',
                    'integration_mapping', id, ?, ?, unixepoch()
               FROM integration_entity_mappings
              WHERE connection_id = ? AND entity_type = ? AND entity_id = ?
                AND last_operation_id = ?`,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          operationId,
          JSON.stringify({
            connectionId,
            entityType: input.entityType,
            entityId: input.entityId,
            externalId: input.externalId,
          }),
          connectionId,
          input.entityType,
          input.entityId,
          operationId,
        ),
      ]);
      if ((saved.meta.changes ?? 0) !== 1) {
        throw new IntegrationStateError("The mapping could not be saved.");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /integration_entity_mappings\.connection_id.*external_id/i.test(
          error.message,
        )
      ) {
        throw new IntegrationStateError(
          "That external identifier is already mapped in this connection.",
        );
      }
      throw error;
    }
    return { mappingId };
  }

  async deleteMapping(
    viewer: Viewer,
    connectionId: string,
    entityType: z.infer<typeof integrationMappingInputSchema>["entityType"],
    entityId: string,
    operationId: string = crypto.randomUUID(),
  ) {
    this.assertAdministrator(viewer);
    const prior = await this.env.DB.prepare(
      `SELECT mapping.id
         FROM integration_entity_mappings mapping
         JOIN integration_connections connection
           ON connection.id = mapping.connection_id
        WHERE mapping.connection_id = ? AND mapping.entity_type = ?
          AND mapping.entity_id = ? AND connection.event_id = ?
          AND connection.organisation_id = ?`,
    )
      .bind(
        connectionId,
        entityType,
        entityId,
        viewer.eventId,
        viewer.organisationId,
      )
      .first<{ id: string }>();
    if (!prior) {
      const recovered = await this.env.DB.prepare(
        `SELECT entity_id AS mappingId FROM audit_events
          WHERE organisation_id = ? AND event_id = ?
            AND action = 'integration.mapping.deleted'
            AND correlation_id = ? LIMIT 1`,
      )
        .bind(viewer.organisationId, viewer.eventId, operationId)
        .first<{ mappingId: string }>();
      if (recovered) return recovered;
      throw new IntegrationStateError("The integration mapping was not found.");
    }
    const [deleted] = await this.env.DB.batch([
      this.env.DB.prepare(
        `DELETE FROM integration_entity_mappings
          WHERE id = ? AND connection_id = ? AND entity_type = ? AND entity_id = ?
            AND EXISTS (
              SELECT 1 FROM integration_connections connection
               WHERE connection.id = integration_entity_mappings.connection_id
                 AND connection.event_id = ? AND connection.organisation_id = ?
            )`,
      ).bind(
        prior.id,
        connectionId,
        entityType,
        entityId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'integration.mapping.deleted',
                  'integration_mapping', ?, ?, ?, unixepoch()
             WHERE changes() = 1`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        prior.id,
        operationId,
        JSON.stringify({ connectionId, entityType, entityId }),
      ),
    ]);
    if ((deleted.meta.changes ?? 0) !== 1) {
      throw new IntegrationStateError(
        "The mapping changed before it could be deleted.",
      );
    }
    return { mappingId: prior.id };
  }
}
