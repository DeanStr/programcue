import type { Viewer } from "~/platform/auth/authorize.server";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import type { PublicSiteCommand } from "./public-site-command.server";
import { PublicSiteIntegrityError } from "./public-site-errors";

type SqlPredicate = {
  sql: string;
  bindings: Array<string | number | null>;
};

type MutationDescriptor = {
  action: string;
  entityType: string;
  entityId: string;
  changeType: "created" | "updated" | "published" | "deleted";
  metadata: Record<string, unknown>;
};

export function publicSiteMutationEvidence(
  env: CloudflareEnvironment,
  viewer: Viewer,
  operationId: string,
  descriptor: MutationDescriptor,
  guard: SqlPredicate,
) {
  const { action, entityType, entityId, changeType, metadata } = descriptor;
  return [
    env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id,
         actor_person_id, action, entity_type, entity_id, correlation_id,
         metadata_json, created_at
       ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch()
          WHERE EXISTS (${guard.sql})`,
    ).bind(
      operationId,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      action,
      entityType,
      entityId,
      operationId,
      JSON.stringify(metadata),
      ...guard.bindings,
    ),
    env.DB.prepare(
      `INSERT INTO event_changes (
         event_id, entity_type, entity_id, change_type, correlation_id, created_at
       ) SELECT ?, ?, ?, ?, ?, unixepoch()
          WHERE EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
       RETURNING sequence`,
    ).bind(
      viewer.eventId,
      entityType,
      entityId,
      changeType,
      operationId,
      operationId,
    ),
  ] as const;
}

export function publicSiteAtomicMutationGuard(
  env: CloudflareEnvironment,
  viewer: Viewer,
  command: PublicSiteCommand,
  descriptor: MutationDescriptor,
  response: Record<string, unknown>,
  activation: SqlPredicate,
  domainInvariant: SqlPredicate,
) {
  return atomicBatchGuardStatement(
    env,
    `EXISTS (${activation.sql})
     AND NOT (
       EXISTS (${domainInvariant.sql})
       AND EXISTS (
         SELECT 1 FROM audit_events audit
          WHERE audit.id = ? AND audit.organisation_id = ?
            AND audit.event_id = ? AND audit.actor_person_id = ?
            AND audit.actor_kind = 'person' AND audit.origin = 'admin_ui'
            AND audit.action = ? AND audit.entity_type = ?
            AND audit.entity_id = ? AND audit.correlation_id = ?
            AND audit.metadata_json = ?
       )
       AND 1 = (
         SELECT COUNT(*) FROM event_changes change
          WHERE change.event_id = ? AND change.entity_type = ?
            AND change.entity_id = ? AND change.change_type = ?
            AND change.correlation_id = ? AND change.sequence > 0
       )
       AND EXISTS (
         SELECT 1 FROM idempotency_records stored
          WHERE stored.id = ? AND stored.organisation_id = ?
            AND stored.event_id = ? AND stored.actor_id = ?
            AND stored.scope = ? AND stored.idempotency_key = ?
            AND stored.request_hash = ? AND stored.status = 'completed'
            AND stored.response_status = 200 AND stored.response_json = ?
            AND stored.completed_at IS NOT NULL
       )
     )`,
    [
      ...activation.bindings,
      ...domainInvariant.bindings,
      command.id,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      descriptor.action,
      descriptor.entityType,
      descriptor.entityId,
      command.id,
      JSON.stringify(descriptor.metadata),
      viewer.eventId,
      descriptor.entityType,
      descriptor.entityId,
      descriptor.changeType,
      command.id,
      command.id,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      command.scope,
      command.key,
      command.requestHash,
      JSON.stringify(response),
    ],
  );
}

export async function publicSiteAtomicBatch(
  env: CloudflareEnvironment,
  statements: D1PreparedStatement[],
) {
  try {
    return await env.DB.batch(statements);
  } catch (error) {
    if (isAtomicBatchGuardError(error)) {
      throw new PublicSiteIntegrityError({ cause: error });
    }
    throw error;
  }
}

export function publicSiteChangeSequence(result: D1Result | undefined) {
  const value = Number(
    (result?.results[0] as { sequence?: number } | undefined)?.sequence,
  );
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(
      "The public-site mutation committed without a change cursor.",
    );
  return value;
}
