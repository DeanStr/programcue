import type { Viewer } from "~/platform/auth/authorize.server";

export function publicSiteMutationEvidence(
  env: CloudflareEnvironment,
  viewer: Viewer,
  operationId: string,
  action: string,
  entityType: string,
  entityId: string,
  changeType: "created" | "updated" | "published" | "deleted",
  metadata: Record<string, unknown>,
  guard: { sql: string; bindings: Array<string | number | null> },
) {
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
