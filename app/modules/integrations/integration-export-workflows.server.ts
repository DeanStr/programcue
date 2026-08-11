import { z } from "zod";
import {
  ACCELEVENTS_SESSION_SPEAKER_WRITE_UNSUPPORTED,
  ACCELEVENTS_TRACK_UPDATE_UNSUPPORTED,
  type AcceleventsSessionPayload,
  type AcceleventsSessionSpeakerAssociationPayload,
  type AcceleventsSpeakerPayload,
  type AcceleventsTrackPayload,
} from "./accelevents-provider.server";
import { IntegrationMappingWorkflows } from "./integration-mapping-workflows.server";
import {
  IntegrationStateError,
  acceleventsSessionFormat,
  eventLocalDateTime,
  integrationRunMessageSchema,
  planItem,
  sourceHash,
  splitName,
  startRunSchema,
  summary,
  type IntegrationAdminActor,
  type IntegrationPlanItem,
  type LocalSessionRow,
  type LocalSessionSpeakerRow,
  type LocalSpeakerRow,
  type LocalTrackRow,
  type MappingRow,
} from "./integration-service-foundation.server";

export abstract class IntegrationExportWorkflows extends IntegrationMappingWorkflows {
  async preview(viewer: IntegrationAdminActor, connectionId: string) {
    this.assertAdministrator(viewer);
    await this.airtable.assertReadable(viewer);
    const connection = await this.env.DB.prepare(
      `SELECT id, provider, status, revision,
              configuration_json AS configurationJson
         FROM integration_connections
        WHERE id = ? AND event_id = ? AND organisation_id = ?`,
    )
      .bind(connectionId, viewer.eventId, viewer.organisationId)
      .first<{
        id: string;
        provider: string;
        status: string;
        revision: number;
        configurationJson: string;
      }>();
    if (!connection)
      throw new IntegrationStateError("Integration connection not found.");
    if (connection.provider !== "accelevents")
      throw new IntegrationStateError(
        "This integration provider is not supported by this export.",
      );
    if (connection.status !== "connected")
      throw new IntegrationStateError(
        "Reconnect Accelevents before previewing an export.",
      );
    let connectionConfiguration: unknown;
    try {
      connectionConfiguration = JSON.parse(connection.configurationJson);
    } catch {
      throw new IntegrationStateError(
        "The Accelevents connection configuration is invalid. Reconnect before exporting.",
      );
    }
    const parsedConfiguration = z
      .object({
        sessionTypeFormat: z.enum(["VIRTUAL", "IN_PERSON", "HYBRID"]),
        demoNoWriteFixture: z.boolean().optional(),
      })
      .safeParse(connectionConfiguration);
    if (!parsedConfiguration.success) {
      throw new IntegrationStateError(
        "The Accelevents connection is missing its event delivery format. Reconnect before exporting.",
      );
    }
    const { sessionTypeFormat } = parsedConfiguration.data;
    const demoNoWriteFixture =
      parsedConfiguration.data.demoNoWriteFixture === true;
    if (demoNoWriteFixture && String(this.env.DEMO_MODE) !== "true") {
      throw new IntegrationStateError(
        "A demo-only Accelevents fixture cannot be used outside demo mode.",
      );
    }

    const [speakers, tracks, sessions, sessionSpeakers, mappings] =
      await Promise.all([
        this.env.DB.prepare(
          `SELECT DISTINCT person.id, person.display_name AS displayName, person.email,
                person.biography, person.organisation_name AS organisationName,
                person.job_title AS jobTitle
           FROM schedule_versions version
           JOIN schedule_entries entry ON entry.schedule_version_id = version.id
           JOIN sessions session ON session.id = entry.session_id AND session.event_id = version.event_id
           JOIN session_speakers relationship ON relationship.session_id = session.id
                AND relationship.event_id = session.event_id
           JOIN people person ON person.id = relationship.person_id
          WHERE version.event_id = ? AND version.status = 'published'
            AND session.status = 'published' AND relationship.visibility <> 'hidden'
          ORDER BY person.display_name, person.id`,
        )
          .bind(viewer.eventId)
          .all<LocalSpeakerRow>(),
        this.env.DB.prepare(
          `SELECT DISTINCT track.id, track.name, track.slug,
                track.colour_token AS colour, track.position
           FROM schedule_versions version
           JOIN schedule_entries entry ON entry.schedule_version_id = version.id
                AND entry.event_id = version.event_id
           JOIN sessions session ON session.id = entry.session_id
                AND session.event_id = version.event_id
           JOIN tracks track ON track.id = session.track_id
                AND track.event_id = session.event_id
          WHERE version.event_id = ? AND version.status = 'published'
            AND session.status = 'published'
          ORDER BY track.position, track.name, track.id`,
        )
          .bind(viewer.eventId)
          .all<LocalTrackRow>(),
        this.env.DB.prepare(
          `SELECT session.id, session.title, session.description, session.format,
                session.visibility, entry.starts_at AS startsAt, entry.ends_at AS endsAt,
                room.name AS room, event.timezone
           FROM schedule_versions version
           JOIN schedule_entries entry ON entry.schedule_version_id = version.id
           JOIN sessions session ON session.id = entry.session_id AND session.event_id = version.event_id
           JOIN events event ON event.id = version.event_id AND event.organisation_id = ?
           LEFT JOIN rooms room ON room.id = entry.room_id AND room.event_id = version.event_id
          WHERE version.event_id = ? AND version.status = 'published'
            AND session.status = 'published'
          ORDER BY entry.starts_at, session.id`,
        )
          .bind(viewer.organisationId, viewer.eventId)
          .all<LocalSessionRow>(),
        this.env.DB.prepare(
          `SELECT relationship.session_id AS sessionId,
                session.title AS sessionTitle,
                relationship.person_id AS personId,
                person.display_name AS displayName,
                relationship.position,
                relationship.role_label AS roleLabel
           FROM schedule_versions version
           JOIN schedule_entries entry ON entry.schedule_version_id = version.id
                AND entry.event_id = version.event_id
           JOIN sessions session ON session.id = entry.session_id
                AND session.event_id = version.event_id
           JOIN session_speakers relationship
                ON relationship.session_id = session.id
               AND relationship.event_id = session.event_id
           JOIN people person ON person.id = relationship.person_id
          WHERE version.event_id = ? AND version.status = 'published'
            AND session.status = 'published'
            AND relationship.visibility <> 'hidden'
          ORDER BY session.id, relationship.position, relationship.person_id`,
        )
          .bind(viewer.eventId)
          .all<LocalSessionSpeakerRow>(),
        this.env.DB.prepare(
          `SELECT entity_type AS entityType, entity_id AS entityId,
                external_id AS externalId, source_hash AS sourceHash,
                metadata_json AS metadataJson
           FROM integration_entity_mappings WHERE connection_id = ?`,
        )
          .bind(connectionId)
          .all<MappingRow>(),
      ]);
    const mappingByEntity = new Map(
      mappings.results.map((mapping) => [
        `${mapping.entityType}:${mapping.entityId}`,
        mapping,
      ]),
    );
    const items: IntegrationPlanItem[] = [];
    for (const speaker of speakers.results) {
      const name = splitName(speaker.displayName);
      const payload: AcceleventsSpeakerPayload = {
        ...name,
        email: speaker.email,
        ...(speaker.biography ? { bio: speaker.biography } : {}),
        ...(speaker.organisationName
          ? { company: speaker.organisationName }
          : {}),
        ...(speaker.jobTitle ? { title: speaker.jobTitle } : {}),
        allowAttendeeAccess: true,
        allowOverrideDetails: true,
      };
      const mapping = mappingByEntity.get(`speaker:${speaker.id}`);
      items.push(
        await planItem({
          entityType: "speaker",
          entityId: speaker.id,
          label: speaker.displayName,
          externalId: mapping?.externalId ?? null,
          payload,
          mapping,
          providerSupport: "supported",
          providerMessage: null,
        }),
      );
    }
    for (const track of tracks.results) {
      const payload: AcceleventsTrackPayload = {
        type: "TRACK",
        name: track.name,
        ...(track.colour ? { color: track.colour } : {}),
        description: `Program Cue track: ${track.slug}`,
        position: track.position,
      };
      const mapping = mappingByEntity.get(`track:${track.id}`);
      const item = await planItem({
        entityType: "track",
        entityId: track.id,
        label: track.name,
        externalId: mapping?.externalId ?? null,
        payload,
        mapping,
        providerSupport: mapping ? "blocked" : "supported",
        providerMessage: mapping ? ACCELEVENTS_TRACK_UPDATE_UNSUPPORTED : null,
      });
      if (item.action === "noop") {
        item.providerSupport = "supported";
        item.providerMessage = null;
      }
      items.push(item);
    }
    for (const session of sessions.results) {
      const payload: AcceleventsSessionPayload = {
        title: session.title,
        ...(session.description ? { description: session.description } : {}),
        startTime: eventLocalDateTime(session.startsAt, session.timezone),
        endTime: eventLocalDateTime(session.endsAt, session.timezone),
        format: acceleventsSessionFormat(session.format),
        status: session.visibility === "hidden" ? "HIDDEN" : "VISIBLE",
        sessionVisibilityType:
          session.visibility === "private" ? "PRIVATE" : "PUBLIC",
        sessionTypeFormat,
        ...(session.room ? { location: session.room } : {}),
      };
      const mapping = mappingByEntity.get(`session:${session.id}`);
      items.push(
        await planItem({
          entityType: "session",
          entityId: session.id,
          label: session.title,
          externalId: mapping?.externalId ?? null,
          payload,
          mapping,
          providerSupport: "supported",
          providerMessage: null,
        }),
      );
    }
    for (const association of sessionSpeakers.results) {
      const entityId = `${association.sessionId}:${association.personId}`;
      const payload: AcceleventsSessionSpeakerAssociationPayload = {
        sessionId: association.sessionId,
        speakerId: association.personId,
        position: association.position,
        roleLabel: association.roleLabel,
      };
      const mapping = mappingByEntity.get(`session_speaker:${entityId}`);
      items.push(
        await planItem({
          entityType: "session_speaker",
          entityId,
          label: `${association.displayName} → ${association.sessionTitle}`,
          externalId: mapping?.externalId ?? null,
          payload,
          mapping,
          providerSupport: "blocked",
          providerMessage: ACCELEVENTS_SESSION_SPEAKER_WRITE_UNSUPPORTED,
        }),
      );
    }
    const previewFingerprint = await sourceHash({
      connectionId: connection.id,
      connectionRevision: connection.revision,
      items,
    });
    return {
      connection: { ...connection, demoNoWriteFixture },
      items,
      summary: summary(items),
      previewFingerprint,
    };
  }

  async startRun(viewer: IntegrationAdminActor, raw: unknown) {
    this.assertAdministrator(viewer);
    const auditActor = this.auditActor(viewer);
    const input = startRunSchema.parse(raw);
    const requestHash = await sourceHash({
      connectionId: input.connectionId,
      dryRun: input.dryRun,
      previewFingerprint: input.previewFingerprint ?? null,
    });
    const duplicate = await this.existingRun(
      viewer,
      input.connectionId,
      input.idempotencyKey,
    );
    if (duplicate) return this.replayRun(duplicate, input.dryRun, requestHash);

    const preview = await this.preview(viewer, input.connectionId);
    if (
      input.previewFingerprint &&
      input.previewFingerprint !== preview.previewFingerprint
    ) {
      throw new IntegrationStateError(
        "The Accelevents export changed after it was previewed. Review the refreshed mapping before confirming it.",
      );
    }
    if (preview.connection.demoNoWriteFixture && !input.dryRun) {
      throw new IntegrationStateError(
        "The demo-only Accelevents fixture supports no-write dry runs only. Configure verified provider credentials before starting a live export.",
      );
    }
    const runId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const runSummary = {
      ...summary(preview.items),
      requestHash,
      previewFingerprint: preview.previewFingerprint,
    };
    const noProviderWork = preview.items.every(
      (item) => item.action === "noop",
    );
    const completeImmediately = input.dryRun || noProviderWork;
    const message = integrationRunMessageSchema.parse({
      type: "integration.accelevents.export",
      operationId,
      runId,
      connectionId: input.connectionId,
      connectionRevision: preview.connection.revision,
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
    });
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json, result_json,
           progress_total, progress_completed, progress_failed, cancellable,
           completed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'integration.accelevents.export', ?, ?, ?, ?, ?,
                   ?, ?, 0, 0, ?, unixepoch(), unixepoch())`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        input.idempotencyKey,
        correlationId,
        completeImmediately ? "completed" : "queued",
        JSON.stringify(message),
        completeImmediately ? JSON.stringify(runSummary) : null,
        preview.items.length,
        completeImmediately ? preview.items.length : runSummary.noop,
        completeImmediately ? Math.floor(Date.now() / 1_000) : null,
      ),
      this.env.DB.prepare(
        `INSERT INTO integration_runs (
           id, connection_id, operation_id, idempotency_key, status, direction,
           dry_run, summary_json, started_at, completed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, unixepoch())`,
      ).bind(
        runId,
        input.connectionId,
        operationId,
        input.idempotencyKey,
        completeImmediately ? "succeeded" : "queued",
        input.dryRun ? 1 : 0,
        JSON.stringify(runSummary),
        completeImmediately ? Math.floor(Date.now() / 1_000) : null,
        completeImmediately ? Math.floor(Date.now() / 1_000) : null,
      ),
      ...preview.items.flatMap((item) => {
        const itemId = crypto.randomUUID();
        const itemKey = `${item.entityType}:${item.entityId}`;
        const itemStatus =
          input.dryRun || item.action === "noop" ? "skipped" : "pending";
        const diff = JSON.stringify({
          label: item.label,
          payload: item.payload,
          sourceHash: item.sourceHash,
          previousExternalId: item.externalId,
          changes: item.changes,
          providerSupport: item.providerSupport,
          providerMessage: item.providerMessage,
        });
        return [
          this.env.DB.prepare(
            `INSERT INTO integration_run_items (
               id, run_id, entity_type, entity_id, external_id, action, status,
               diff_json, attempt_count, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, unixepoch())`,
          ).bind(
            itemId,
            runId,
            item.entityType,
            item.entityId,
            item.externalId,
            item.action,
            itemStatus,
            diff,
          ),
          this.env.DB.prepare(
            `INSERT INTO operation_items (
               id, operation_id, item_key, entity_type, entity_id, status,
               result_json, updated_at, completed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), ?)`,
          ).bind(
            crypto.randomUUID(),
            operationId,
            itemKey,
            item.entityType,
            item.entityId,
            itemStatus,
            diff,
            itemStatus === "skipped" ? Math.floor(Date.now() / 1_000) : null,
          ),
        ];
      }),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, actor_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, 'integration.run.created', 'integration_run', ?, ?, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        auditActor.actorId,
        runId,
        correlationId,
        JSON.stringify({ dryRun: input.dryRun, ...runSummary }),
      ),
    ];
    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      // A concurrent request can win the unique (connection, key) claim after
      // our initial lookup. Return its durable result instead of surfacing the
      // storage constraint as a spurious 500. Other storage failures still fail.
      const winner = await this.existingRun(
        viewer,
        input.connectionId,
        input.idempotencyKey,
      );
      if (!winner) throw error;
      return this.replayRun(winner, input.dryRun, requestHash);
    }
    if (!completeImmediately) {
      try {
        await this.enqueue(message);
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE operation_jobs SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
              WHERE id = ? AND status = 'queued'`,
          ).bind(failure.slice(0, 2_000), operationId),
          this.env.DB.prepare(
            `UPDATE integration_runs SET status = 'failed', summary_json = json_set(summary_json, '$.queueError', ?), completed_at = unixepoch()
              WHERE id = ? AND status = 'queued'`,
          ).bind(failure.slice(0, 2_000), runId),
        ]);
        throw new IntegrationStateError(
          `The export was saved as ${operationId}, but Queue delivery failed. Retry it from Operations.`,
        );
      }
    }
    return {
      runId,
      operationId,
      queued: !completeImmediately,
      replayed: false,
      previewFingerprint: preview.previewFingerprint,
    };
  }
}
