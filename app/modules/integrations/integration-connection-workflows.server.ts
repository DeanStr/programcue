import type { Viewer } from "~/platform/auth/authorize.server";
import { acceleventsCredentialsSchema } from "./accelevents-provider.server";
import { encryptIntegrationCredentials } from "./integration-credentials.server";
import {
  IntegrationServiceFoundation,
  IntegrationStateError,
  configureIntegrationConnectionSchema,
  type ConnectionRow,
} from "./integration-service-foundation.server";

export abstract class IntegrationConnectionWorkflows extends IntegrationServiceFoundation {
  async getWorkspace(viewer: Viewer) {
    this.assertAdministrator(viewer);
    const [connections, runs] = await Promise.all([
      this.env.DB.prepare(
        `SELECT id, provider, status, direction, configuration_json AS configurationJson,
                encrypted_credentials AS encryptedCredentials, updated_at AS updatedAt
           FROM integration_connections
          WHERE event_id = ? AND organisation_id = ? AND provider = 'accelevents'
          ORDER BY updated_at DESC`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .all<ConnectionRow>(),
      this.env.DB.prepare(
        `SELECT run.id, run.connection_id AS connectionId, run.operation_id AS operationId,
                connection.provider,
                run.status, run.direction, run.dry_run AS dryRun,
                run.summary_json AS summaryJson, run.created_at AS createdAt,
                run.completed_at AS completedAt
           FROM integration_runs run
           JOIN integration_connections connection ON connection.id = run.connection_id
          WHERE connection.event_id = ? AND connection.organisation_id = ?
            AND connection.provider = 'accelevents'
          ORDER BY run.created_at DESC LIMIT 25`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .all<{
          id: string;
          connectionId: string;
          operationId: string;
          provider: string;
          status: string;
          direction: string;
          dryRun: number;
          summaryJson: string;
          createdAt: number;
          completedAt: number | null;
        }>(),
    ]);
    return {
      connections: connections.results.map((connection) => {
        const configuration = JSON.parse(
          connection.configurationJson,
        ) as unknown;
        const demoNoWriteFixture = Boolean(
          configuration &&
            typeof configuration === "object" &&
            "demoNoWriteFixture" in configuration &&
            configuration.demoNoWriteFixture === true,
        );
        return {
          ...connection,
          configuration,
          demoNoWriteFixture,
          hasCredentials: Boolean(connection.encryptedCredentials),
          encryptedCredentials: undefined,
        };
      }),
      runs: runs.results.map((run) => ({
        ...run,
        dryRun: Boolean(run.dryRun),
        summary: JSON.parse(run.summaryJson) as unknown,
      })),
    };
  }

  async configureAccelevents(
    viewer: Viewer,
    raw: unknown,
    command?: { operationId: string; connectionId: string },
  ) {
    this.assertAdministrator(viewer);
    const input = configureIntegrationConnectionSchema.parse(raw);
    const credentials = acceleventsCredentialsSchema.parse(input);
    const existing = await this.env.DB.prepare(
      `SELECT id, revision FROM integration_connections
        WHERE event_id = ? AND organisation_id = ? AND provider = 'accelevents'
        ORDER BY created_at LIMIT 1`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ id: string; revision: number }>();
    const connectionId =
      existing?.id ?? command?.connectionId ?? crypto.randomUUID();
    const operationId = command?.operationId ?? crypto.randomUUID();
    if (command) {
      const recovered = await this.env.DB.prepare(
        `SELECT id FROM integration_connections
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND provider = 'accelevents' AND status = 'connected'
            AND last_operation_id = ?`,
      )
        .bind(connectionId, viewer.eventId, viewer.organisationId, operationId)
        .first();
      if (recovered) return { connectionId };
    }
    const encrypted = await encryptIntegrationCredentials(
      credentials,
      this.env.INTEGRATION_CREDENTIALS_KEY,
      connectionId,
    );
    await this.accelevents(credentials).validateConnection();
    const configuration = JSON.stringify({
      eventUrl: credentials.eventUrl,
      externalEventId: credentials.externalEventId,
      sessionTypeFormat: credentials.sessionTypeFormat,
    });
    const statements: D1PreparedStatement[] = existing
      ? [
          this.env.DB.prepare(
            `UPDATE integration_connections
                SET status = 'connected', direction = 'outbound',
                    encrypted_credentials = ?, configuration_json = ?,
                    revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
              WHERE id = ? AND event_id = ? AND organisation_id = ? AND revision = ?`,
          ).bind(
            encrypted,
            configuration,
            operationId,
            connectionId,
            viewer.eventId,
            viewer.organisationId,
            existing.revision,
          ),
        ]
      : [
          this.env.DB.prepare(
            `INSERT INTO integration_connections (
               id, organisation_id, event_id, provider, status, direction,
               conflict_policy, encrypted_credentials, configuration_json,
               revision, last_operation_id, created_at, updated_at
             ) VALUES (?, ?, ?, 'accelevents', 'connected', 'outbound',
                       'program_cue_wins', ?, ?, 1, ?, unixepoch(), unixepoch())`,
          ).bind(
            connectionId,
            viewer.organisationId,
            viewer.eventId,
            encrypted,
            configuration,
            operationId,
          ),
        ];
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'integration.connection.saved',
                'integration_connection', ?, ?, ?, unixepoch()
          FROM integration_connections
         WHERE id = ? AND event_id = ? AND organisation_id = ?
           AND last_operation_id = ?`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        connectionId,
        operationId,
        JSON.stringify({
          provider: "accelevents",
          eventUrl: credentials.eventUrl,
        }),
        connectionId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    );
    const results = await this.env.DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1)
      throw new IntegrationStateError(
        "The integration connection changed before it could be saved.",
      );
    return { connectionId };
  }

  async disconnect(
    viewer: Viewer,
    connectionId: string,
    suppliedOperationId?: string,
  ) {
    this.assertAdministrator(viewer);
    const current = await this.env.DB.prepare(
      `SELECT connection.revision, connection.provider,
              event.repository_provider AS repositoryProvider
         FROM integration_connections connection
         JOIN events event
           ON event.id = connection.event_id
          AND event.organisation_id = connection.organisation_id
        WHERE connection.id = ? AND connection.event_id = ?
          AND connection.organisation_id = ?
          AND connection.status <> 'disconnected'`,
    )
      .bind(connectionId, viewer.eventId, viewer.organisationId)
      .first<{
        revision: number;
        provider: string;
        repositoryProvider: string;
      }>();
    if (!current) {
      if (suppliedOperationId) {
        const recovered = await this.env.DB.prepare(
          `SELECT 1 FROM integration_connections
            WHERE id = ? AND event_id = ? AND organisation_id = ?
              AND status = 'disconnected' AND last_operation_id = ?`,
        )
          .bind(
            connectionId,
            viewer.eventId,
            viewer.organisationId,
            suppliedOperationId,
          )
          .first();
        if (recovered) return { connectionId };
      }
      throw new IntegrationStateError(
        "The active integration connection was not found.",
      );
    }
    if (
      current.provider === "airtable_repository" &&
      current.repositoryProvider === "airtable"
    )
      throw new IntegrationStateError(
        "Hand event data back to Program Cue before disconnecting Airtable.",
      );
    const operationId = suppliedOperationId ?? crypto.randomUUID();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE integration_connections
            SET status = 'disconnected', encrypted_credentials = NULL,
                revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ? AND revision = ?
            AND status <> 'disconnected'
            AND NOT (
              provider = 'airtable_repository'
              AND EXISTS (
                SELECT 1 FROM events event
                 WHERE event.id = integration_connections.event_id
                   AND event.organisation_id = integration_connections.organisation_id
                   AND event.repository_provider = 'airtable'
              )
            )`,
      ).bind(
        operationId,
        connectionId,
        viewer.eventId,
        viewer.organisationId,
        current.revision,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'integration.connection.disconnected',
                'integration_connection', ?, ?, '{}', unixepoch()
          FROM integration_connections
         WHERE id = ? AND event_id = ? AND organisation_id = ?
           AND last_operation_id = ?`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        connectionId,
        operationId,
        connectionId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1)
      throw new IntegrationStateError(
        "The integration connection changed before it could be disconnected.",
      );
    return { connectionId };
  }
}
