import { z } from "zod";

import {
  AcceleventsProvider,
  acceleventsCredentialsSchema,
  acceleventsSessionPayloadSchema,
  acceleventsSessionSpeakerAssociationPayloadSchema,
  acceleventsSpeakerPayloadSchema,
  acceleventsTrackPayloadSchema,
} from "../../app/modules/integrations/accelevents-provider.server";
import { acceleventsRunItemDiffSchema } from "../../app/modules/integrations/accelevents-run-contract";
import { decryptIntegrationCredentials } from "../../app/modules/integrations/integration-credentials.server";
import { integrationRunMessageSchema } from "../../app/modules/integrations/integration-service.server";
import {
  assertOperationClaim,
  errorDetails,
  loadOperationClaim,
  notifyRealtimeAfterCommit,
  QUEUE_CLAIM_LEASE_SECONDS,
  QueueClaimLeaseBusyError,
  QueueClaimLeaseLostError,
  renewOperationClaim,
  returnedChangeSequence,
} from "./claim-infrastructure";

type ExportProvider = Pick<
  AcceleventsProvider,
  | "associateSessionSpeaker"
  | "createTrack"
  | "updateTrack"
  | "upsertSession"
  | "upsertSpeaker"
>;

type AcceleventsExportDependencies = {
  createProvider?: (
    credentials: z.infer<typeof acceleventsCredentialsSchema>,
  ) => ExportProvider;
};

type RunContext = {
  runId: string;
  runStatus: string;
  connectionId: string;
  encryptedCredentials: string | null;
  configurationJson: string;
  connectionRevision: number;
};

type ExportItem = {
  id: string;
  entityType: "speaker" | "track" | "session" | "session_speaker";
  entityId: string;
  externalId: string | null;
  action: "create" | "update";
  status: string;
  diffJson: string;
  attemptCount: number;
};

function assertApprovedMapping(
  item: ExportItem,
  currentExternalId: string | null,
) {
  if (currentExternalId !== item.externalId) {
    throw new Error(
      `The Accelevents ${item.entityType.replaceAll("_", "-")} mapping changed after this run was previewed. Skip this item and start a new preview before sending another provider write.`,
    );
  }
  if (item.action === "create" && item.externalId !== null) {
    throw new Error(
      `The stored Accelevents ${item.entityType.replaceAll("_", "-")} create unexpectedly contains an external identifier. Start a new preview before sending provider work.`,
    );
  }
  if (item.action === "update" && item.externalId === null) {
    throw new Error(
      `The stored Accelevents ${item.entityType.replaceAll("_", "-")} update has no approved external identifier. Start a new preview before sending provider work.`,
    );
  }
}

function assertCreateCanRun(
  item: ExportItem,
  providerWriteIsImpossible: boolean,
) {
  if (
    item.action === "create" &&
    item.attemptCount > 0 &&
    item.entityType !== "session_speaker" &&
    !providerWriteIsImpossible
  ) {
    throw new Error(
      `This ${item.entityType} create may already have reached Accelevents, but no external identifier was committed. Resolve the provider record manually, then skip this item and start a new preview; Program Cue will not risk creating a duplicate.`,
    );
  }
}

async function stableMappingId(
  connectionId: string,
  entityType: string,
  entityId: string,
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${connectionId}\u0000${entityType}\u0000${entityId}`,
    ),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `accelevents:${hash}`;
}

async function claimOperation(
  env: CloudflareEnvironment,
  message: z.infer<typeof integrationRunMessageSchema>,
) {
  const token = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'running', claim_token = ?, claim_expires_at = unixepoch() + ?,
            attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, unixepoch()), completed_at = NULL,
            last_error = NULL, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND organisation_id = ?
        AND type = 'integration.accelevents.export'
        AND (
          (status IN ('queued','queue_failed','received','retrying')
           AND claim_token IS NULL)
          OR (status = 'running' AND claim_expires_at IS NOT NULL
              AND claim_expires_at <= unixepoch())
        )`,
  )
    .bind(
      token,
      QUEUE_CLAIM_LEASE_SECONDS,
      message.operationId,
      message.eventId,
      message.organisationId,
    )
    .run();
  if ((claim.meta.changes ?? 0) === 1) return token;
  const state = await loadOperationClaim(
    env,
    message.operationId,
    message.eventId,
  );
  if (!state) throw new Error("The integration operation does not exist.");
  if (
    ["completed", "cancelled", "failed", "partially_failed"].includes(
      state.status,
    )
  ) {
    return null;
  }
  if (
    state.status === "running" &&
    state.claimToken &&
    (state.claimExpiresAt ?? 0) > Math.floor(Date.now() / 1_000)
  )
    throw new QueueClaimLeaseBusyError();
  throw new QueueClaimLeaseLostError();
}

async function finishItem(
  env: CloudflareEnvironment,
  message: z.infer<typeof integrationRunMessageSchema>,
  claimToken: string,
  item: ExportItem,
  externalId: string,
  sourceHash: string,
  payload: unknown,
) {
  const mappingId = await stableMappingId(
    message.connectionId,
    item.entityType,
    item.entityId,
  );
  const metadataJson = JSON.stringify({ payload });
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO integration_entity_mappings (
         id, connection_id, entity_type, entity_id, external_id, source_hash,
         metadata_json, last_synced_at, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch(), unixepoch()
        WHERE EXISTS (
          SELECT 1 FROM operation_jobs
           WHERE id = ? AND event_id = ? AND organisation_id = ?
             AND status = 'running' AND claim_token = ?
        )
       ON CONFLICT(connection_id, entity_type, entity_id) DO UPDATE SET
         external_id = excluded.external_id,
         source_hash = excluded.source_hash,
         metadata_json = excluded.metadata_json,
         last_synced_at = unixepoch(),
         updated_at = unixepoch()
       WHERE EXISTS (
          SELECT 1 FROM operation_jobs
           WHERE id = ? AND event_id = ? AND organisation_id = ?
             AND status = 'running' AND claim_token = ?
       )`,
    ).bind(
      mappingId,
      message.connectionId,
      item.entityType,
      item.entityId,
      externalId,
      sourceHash,
      metadataJson,
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
    ),
    env.DB.prepare(
      `UPDATE integration_run_items
          SET status = 'succeeded', external_id = ?, error_code = NULL,
              error_message = NULL, updated_at = unixepoch()
        WHERE id = ? AND run_id = ?
          AND EXISTS (
            SELECT 1 FROM operation_jobs
             WHERE id = ? AND event_id = ? AND organisation_id = ?
               AND status = 'running' AND claim_token = ?
          )`,
    ).bind(
      externalId,
      item.id,
      message.runId,
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
    ),
    env.DB.prepare(
      `UPDATE operation_items
          SET status = 'completed', result_json = json_set(
                COALESCE(result_json, '{}'), '$.externalId', ?
              ), error_code = NULL, error_message = NULL,
              completed_at = unixepoch(), updated_at = unixepoch()
        WHERE operation_id = ? AND item_key = ?
          AND EXISTS (
            SELECT 1 FROM operation_jobs
             WHERE id = ? AND event_id = ? AND organisation_id = ?
               AND status = 'running' AND claim_token = ?
          )`,
    ).bind(
      externalId,
      message.operationId,
      `${item.entityType}:${item.entityId}`,
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
    ),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1)
    throw new QueueClaimLeaseLostError();
}

async function failItem(
  env: CloudflareEnvironment,
  message: z.infer<typeof integrationRunMessageSchema>,
  claimToken: string,
  item: ExportItem,
  error: unknown,
) {
  const detail = errorDetails(error);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE integration_run_items
          SET status = 'failed', error_code = ?, error_message = ?, updated_at = unixepoch()
        WHERE id = ? AND run_id = ?
          AND EXISTS (
            SELECT 1 FROM operation_jobs
             WHERE id = ? AND event_id = ? AND organisation_id = ?
               AND status = 'running' AND claim_token = ?
          )`,
    ).bind(
      detail.code,
      detail.message,
      item.id,
      message.runId,
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
    ),
    env.DB.prepare(
      `UPDATE operation_items
          SET status = 'failed', attempt_count = attempt_count + 1,
              error_code = ?, error_message = ?, completed_at = unixepoch(), updated_at = unixepoch()
        WHERE operation_id = ? AND item_key = ?
          AND EXISTS (
            SELECT 1 FROM operation_jobs
             WHERE id = ? AND event_id = ? AND organisation_id = ?
               AND status = 'running' AND claim_token = ?
          )`,
    ).bind(
      detail.code,
      detail.message,
      message.operationId,
      `${item.entityType}:${item.entityId}`,
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1)
    throw new QueueClaimLeaseLostError();
}

async function finishOwnedAcceleventsFailure(
  env: CloudflareEnvironment,
  message: z.infer<typeof integrationRunMessageSchema>,
  claimToken: string,
  error: unknown,
) {
  const failure = errorDetails(error);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE integration_run_items
          SET status = 'failed', error_code = ?, error_message = ?, updated_at = unixepoch()
        WHERE run_id = ? AND status IN ('pending','running')
          AND EXISTS (
            SELECT 1 FROM integration_runs owned_run
            JOIN operation_jobs owned_operation ON owned_operation.id = owned_run.operation_id
             WHERE owned_run.id = integration_run_items.run_id
               AND owned_run.operation_id = ?
               AND owned_operation.event_id = ?
               AND owned_operation.organisation_id = ?
               AND owned_operation.status = 'running'
               AND owned_operation.claim_token = ?
          )`,
    ).bind(
      failure.code,
      failure.message,
      message.runId,
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
    ),
    env.DB.prepare(
      `UPDATE operation_items
          SET status = 'failed', error_code = ?, error_message = ?,
              completed_at = unixepoch(), updated_at = unixepoch()
        WHERE operation_id = ? AND status IN ('pending','running')
          AND EXISTS (
            SELECT 1 FROM operation_jobs owned_operation
             WHERE owned_operation.id = operation_items.operation_id
               AND owned_operation.event_id = ?
               AND owned_operation.organisation_id = ?
               AND owned_operation.status = 'running'
               AND owned_operation.claim_token = ?
          )`,
    ).bind(
      failure.code,
      failure.message,
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
    ),
    env.DB.prepare(
      `UPDATE integration_runs
          SET status = CASE
                WHEN EXISTS (
                  SELECT 1 FROM integration_run_items
                   WHERE run_id = ? AND status IN ('succeeded','skipped')
                ) THEN 'partially_failed'
                ELSE 'failed'
              END,
              summary_json = json_set(
                summary_json,
                '$.completed', (
                  SELECT COUNT(*) FROM integration_run_items
                   WHERE run_id = ? AND status IN ('succeeded','skipped')
                ),
                '$.failed', (
                  SELECT COUNT(*) FROM integration_run_items
                   WHERE run_id = ? AND status = 'failed'
                ),
                '$.skipped', (
                  SELECT COUNT(*) FROM integration_run_items
                   WHERE run_id = ? AND status = 'skipped'
                )
              ),
              completed_at = unixepoch()
        WHERE id = ? AND operation_id = ?
          AND EXISTS (
            SELECT 1 FROM operation_jobs owned_operation
             WHERE owned_operation.id = integration_runs.operation_id
               AND owned_operation.event_id = ?
               AND owned_operation.organisation_id = ?
               AND owned_operation.status = 'running'
               AND owned_operation.claim_token = ?
          )`,
    ).bind(
      message.runId,
      message.runId,
      message.runId,
      message.runId,
      message.runId,
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
    ),
    env.DB.prepare(
      `UPDATE operation_jobs
          SET status = CASE
                WHEN EXISTS (
                  SELECT 1 FROM operation_items
                   WHERE operation_id = ? AND status IN ('completed','skipped')
                ) THEN 'partially_failed'
                ELSE 'failed'
              END,
              progress_total = (
                SELECT COUNT(*) FROM operation_items WHERE operation_id = ?
              ),
              progress_completed = (
                SELECT COUNT(*) FROM operation_items
                 WHERE operation_id = ? AND status IN ('completed','failed','skipped')
              ),
              progress_failed = (
                SELECT COUNT(*) FROM operation_items
                 WHERE operation_id = ? AND status = 'failed'
              ),
              result_json = json_object(
                'total', (
                  SELECT COUNT(*) FROM operation_items WHERE operation_id = ?
                ),
                'completed', (
                  SELECT COUNT(*) FROM operation_items
                   WHERE operation_id = ? AND status IN ('completed','skipped')
                ),
                'failed', (
                  SELECT COUNT(*) FROM operation_items
                   WHERE operation_id = ? AND status = 'failed'
                ),
                'skipped', (
                  SELECT COUNT(*) FROM operation_items
                   WHERE operation_id = ? AND status = 'skipped'
                )
              ),
              last_error = ?, completed_at = unixepoch(),
              claim_token = NULL, claim_expires_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND status = 'running' AND claim_token = ?`,
    ).bind(
      message.operationId,
      message.operationId,
      message.operationId,
      message.operationId,
      message.operationId,
      message.operationId,
      message.operationId,
      message.operationId,
      failure.message,
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
    ),
  ]);
  if ((results[3]?.meta.changes ?? 0) !== 1)
    throw new QueueClaimLeaseLostError();
}

async function processClaimedAcceleventsExport(
  message: z.infer<typeof integrationRunMessageSchema>,
  env: CloudflareEnvironment,
  dependencies: AcceleventsExportDependencies,
  claimToken: string,
) {
  const context = await env.DB.prepare(
    `SELECT run.id AS runId, run.status AS runStatus,
            connection.id AS connectionId,
            connection.encrypted_credentials AS encryptedCredentials,
            connection.configuration_json AS configurationJson,
            connection.revision AS connectionRevision
       FROM integration_runs run
       JOIN integration_connections connection ON connection.id = run.connection_id
      WHERE run.id = ? AND run.connection_id = ? AND run.operation_id = ?
        AND connection.event_id = ? AND connection.organisation_id = ?
        AND connection.provider = 'accelevents'
        AND connection.status = 'connected' AND connection.revision = ?`,
  )
    .bind(
      message.runId,
      message.connectionId,
      message.operationId,
      message.eventId,
      message.organisationId,
      message.connectionRevision,
    )
    .first<RunContext>();
  if (!context)
    throw new Error(
      "The connected Accelevents run context is unavailable or changed after preview.",
    );
  let configuration: unknown;
  try {
    configuration = JSON.parse(context.configurationJson);
  } catch {
    throw new Error("The Accelevents connection configuration is invalid.");
  }
  const demoNoWriteFixture = z
    .object({ demoNoWriteFixture: z.literal(true) })
    .safeParse(configuration).success;
  let provider: ExportProvider;
  if (demoNoWriteFixture) {
    if (String(env.DEMO_MODE) !== "true") {
      throw new Error(
        "A demo-only Accelevents fixture cannot be used outside demo mode.",
      );
    }
    const fail = async () => {
      throw new Error(
        "Demo no-write fixture: no Accelevents request was made. Configure verified provider credentials before retrying a live export.",
      );
    };
    provider = {
      associateSessionSpeaker: fail,
      createTrack: fail,
      updateTrack: fail,
      upsertSession: fail,
      upsertSpeaker: fail,
    };
  } else {
    if (!context.encryptedCredentials)
      throw new Error("The connected Accelevents credentials are unavailable.");
    const credentials = acceleventsCredentialsSchema.parse(
      await decryptIntegrationCredentials(
        context.encryptedCredentials,
        env.INTEGRATION_CREDENTIALS_KEY,
        context.connectionId,
        env.INTEGRATION_CREDENTIALS_PREVIOUS_KEY,
      ),
    );
    provider =
      dependencies.createProvider?.(credentials) ??
      new AcceleventsProvider(credentials);
  }
  await env.DB.prepare(
    `UPDATE integration_runs SET status = 'running', started_at = COALESCE(started_at, unixepoch())
      WHERE id = ? AND status IN ('queued','running','failed','partially_failed')`,
  )
    .bind(message.runId)
    .run();

  const existingMappings = await env.DB.prepare(
    `SELECT mapping.entity_type AS entityType,
            mapping.entity_id AS entityId,
            mapping.external_id AS externalId
       FROM integration_entity_mappings mapping
       JOIN integration_connections connection
         ON connection.id = mapping.connection_id
      WHERE mapping.connection_id = ?
        AND connection.event_id = ? AND connection.organisation_id = ?`,
  )
    .bind(message.connectionId, message.eventId, message.organisationId)
    .all<{ entityType: string; entityId: string; externalId: string }>();
  const externalByEntity = new Map(
    existingMappings.results.map((mapping) => [
      `${mapping.entityType}:${mapping.entityId}`,
      mapping.externalId,
    ]),
  );

  const items = await env.DB.prepare(
    `SELECT id, entity_type AS entityType, entity_id AS entityId,
            external_id AS externalId, action, status, diff_json AS diffJson,
            attempt_count AS attemptCount
       FROM integration_run_items
      WHERE run_id = ? AND action IN ('create','update')
        AND status IN ('pending','running','failed')
        AND (? IS NULL OR id = ?)
      ORDER BY CASE entity_type
                 WHEN 'speaker' THEN 0
                 WHEN 'track' THEN 0
                 WHEN 'session' THEN 1
                 WHEN 'session_speaker' THEN 2
                 ELSE 3
               END,
               entity_id`,
  )
    .bind(message.runId, message.itemId ?? null, message.itemId ?? null)
    .all<ExportItem>();

  for (const item of items.results) {
    await renewOperationClaim(
      env,
      { organisationId: message.organisationId, eventId: message.eventId },
      message.operationId,
      claimToken,
    );
    const marked = await env.DB.prepare(
      `UPDATE integration_run_items
          SET status = 'running', attempt_count = attempt_count + 1, updated_at = unixepoch()
        WHERE id = ? AND run_id = ? AND status IN ('pending','running','failed')
          AND EXISTS (
            SELECT 1 FROM operation_jobs
             WHERE id = ? AND event_id = ? AND organisation_id = ?
               AND status = 'running' AND claim_token = ?
          )
          AND EXISTS (
            SELECT 1 FROM integration_connections connection
             WHERE connection.id = ? AND connection.event_id = ?
               AND connection.organisation_id = ?
               AND connection.provider = 'accelevents'
               AND connection.status = 'connected' AND connection.revision = ?
          )`,
    )
      .bind(
        item.id,
        message.runId,
        message.operationId,
        message.eventId,
        message.organisationId,
        claimToken,
        message.connectionId,
        message.eventId,
        message.organisationId,
        context.connectionRevision,
      )
      .run();
    if ((marked.meta.changes ?? 0) !== 1) {
      await assertOperationClaim(
        env,
        message.operationId,
        message.eventId,
        claimToken,
      );
      throw new Error(
        "The Accelevents connection was disconnected or changed before provider delivery.",
      );
    }
    const diff = acceleventsRunItemDiffSchema.parse(JSON.parse(item.diffJson));
    try {
      assertApprovedMapping(
        item,
        externalByEntity.get(`${item.entityType}:${item.entityId}`) ?? null,
      );
      assertCreateCanRun(item, demoNoWriteFixture);
      let externalId: string;
      if (item.entityType === "speaker") {
        externalId = await provider.upsertSpeaker(
          acceleventsSpeakerPayloadSchema.parse(diff.payload),
          item.externalId,
        );
      } else if (item.entityType === "track") {
        const payload = acceleventsTrackPayloadSchema.parse(diff.payload);
        if (item.externalId) {
          externalId = await provider.updateTrack(payload, item.externalId);
        } else {
          externalId = await provider.createTrack(payload);
        }
      } else if (item.entityType === "session") {
        externalId = await provider.upsertSession(
          acceleventsSessionPayloadSchema.parse(diff.payload),
          item.externalId,
        );
      } else {
        const payload = acceleventsSessionSpeakerAssociationPayloadSchema.parse(
          diff.payload,
        );
        const sessionExternalId = externalByEntity.get(
          `session:${payload.sessionId}`,
        );
        const speakerExternalId = externalByEntity.get(
          `speaker:${payload.speakerId}`,
        );
        if (!sessionExternalId || !speakerExternalId) {
          throw new Error(
            `The session-speaker association dependencies are incomplete (${!sessionExternalId ? "session" : "speaker"} mapping missing). Retry after the dependency succeeds, or skip this item.`,
          );
        }
        externalId = await provider.associateSessionSpeaker(
          sessionExternalId,
          speakerExternalId,
          payload,
        );
      }
      await finishItem(
        env,
        message,
        claimToken,
        item,
        externalId,
        diff.sourceHash,
        diff.payload,
      );
      externalByEntity.set(`${item.entityType}:${item.entityId}`, externalId);
    } catch (error) {
      if (error instanceof QueueClaimLeaseLostError) throw error;
      await failItem(env, message, claimToken, item, error);
    }
  }

  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status IN ('succeeded','skipped') THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
       FROM integration_run_items WHERE run_id = ?`,
  )
    .bind(message.runId)
    .first<{
      total: number;
      completed: number;
      failed: number;
      skipped: number;
    }>();
  if (!counts) throw new Error("The integration run summary is unavailable.");
  const status =
    counts.failed === 0
      ? "completed"
      : counts.completed === 0
        ? "failed"
        : "partially_failed";
  const runStatus = status === "completed" ? "succeeded" : status;
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE integration_runs
          SET status = ?, summary_json = json_set(
                summary_json, '$.completed', ?, '$.failed', ?, '$.skipped', ?
              ), completed_at = unixepoch()
        WHERE id = ? AND status = 'running'
          AND EXISTS (
            SELECT 1 FROM operation_jobs
             WHERE id = ? AND event_id = ? AND organisation_id = ?
               AND status = 'running' AND claim_token = ?
          )`,
    ).bind(
      runStatus,
      counts.completed,
      counts.failed,
      counts.skipped,
      message.runId,
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
    ),
    env.DB.prepare(
      `UPDATE operation_jobs
          SET status = ?, progress_total = ?, progress_completed = ?, progress_failed = ?,
              result_json = ?, last_error = ?, completed_at = unixepoch(),
              claim_token = NULL, claim_expires_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND status = 'running' AND claim_token = ?`,
    ).bind(
      status,
      counts.total,
      counts.total,
      counts.failed,
      JSON.stringify(counts),
      counts.failed ? `${counts.failed} integration record(s) failed.` : null,
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id, action, entity_type, entity_id,
         correlation_id, metadata_json, created_at
       )
       SELECT ?, 'system', 'queue', 1, ?, ?, 'integration.run.completed', 'integration_run', ?,
              correlation_id, ?, unixepoch()
         FROM operation_jobs WHERE id = ? AND status = ?`,
    ).bind(
      crypto.randomUUID(),
      message.organisationId,
      message.eventId,
      message.runId,
      JSON.stringify({ status: runStatus, ...counts }),
      message.operationId,
      status,
    ),
    env.DB.prepare(
      `INSERT INTO event_changes (
         event_id, entity_type, entity_id, change_type, correlation_id, created_at
       )
       SELECT ?, 'integration_run', ?, 'progress', correlation_id, unixepoch()
         FROM operation_jobs WHERE id = ? AND status = ?
       RETURNING sequence`,
    ).bind(message.eventId, message.runId, message.operationId, status),
  ]);
  if ((result[1]?.meta.changes ?? 0) !== 1)
    throw new QueueClaimLeaseLostError();
  await notifyRealtimeAfterCommit(
    env,
    { organisationId: message.organisationId, eventId: message.eventId },
    returnedChangeSequence(result[3]),
    message.operationId,
  );
}

export async function processAcceleventsExport(
  raw: unknown,
  env: CloudflareEnvironment,
  dependencies: AcceleventsExportDependencies = {},
) {
  const message = integrationRunMessageSchema.parse(raw);
  const claimToken = await claimOperation(env, message);
  if (!claimToken) return;
  try {
    await processClaimedAcceleventsExport(
      message,
      env,
      dependencies,
      claimToken,
    );
  } catch (error) {
    if (error instanceof QueueClaimLeaseLostError) throw error;
    await finishOwnedAcceleventsFailure(env, message, claimToken, error);
    throw error;
  }
}
