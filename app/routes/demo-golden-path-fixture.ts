import {
  type ActionFunctionArgs,
  data,
  type LoaderFunctionArgs,
} from "react-router";

import { DEFAULT_EVENT_BRAND_ACCENT } from "~/lib/brand";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  DEMO_ORGANISATION_ID,
} from "~/platform/demo/demo-identities";
import { ensureDemoProgramme } from "~/platform/demo/seed.server";

const CONFIRMATION = "seed-golden-path-browser-fixture";
const ACCELEVENTS_CONNECTION_ID = "demo-accelevents-no-write-connection";
const ACCELEVENTS_OPERATION_ID = "demo-accelevents-failed-operation";
const ACCELEVENTS_RUN_ID = "demo-accelevents-failed-run";
const ACCELEVENTS_RUN_ITEM_ID = "demo-accelevents-failed-run-item";
const ACCELEVENTS_OPERATION_ITEM_ID = "demo-accelevents-failed-operation-item";
const REPOSITORY_RECOVERY_EVENT_ID = "demo-airtable-recovery-event";
const REPOSITORY_RECOVERY_OPERATION_ID =
  "demo-airtable-recovery-failed-operation";
const FAILURE_ALERT_OPERATION_ID = "demo-non-actionable-failed-operation";
const FAILURE_PAGINATION_PREFIX = "demo-paginated-failure-";
const FAILURE_PAGINATION_TYPE = "demo.pagination.failure";

function requireDemo(env: CloudflareEnvironment) {
  if (
    String(env.APP_ENV) !== "demo" ||
    String(env.DEMO_MODE) !== "true" ||
    env.DEFAULT_EVENT_ID !== DEMO_EVENT_ID
  ) {
    throw new Response("Not found", { status: 404 });
  }
}

function methodNotAllowed() {
  return data(
    { ok: false, error: "The golden-path demo fixture requires POST." },
    {
      status: 405,
      headers: { allow: "POST", "cache-control": "private, no-store" },
    },
  );
}

export function loader({ context }: LoaderFunctionArgs) {
  const { env } = getCloudflareContext(context);
  requireDemo(env);
  return methodNotAllowed();
}

async function seedTaskEvidence(env: CloudflareEnvironment) {
  if (!env.FILES) {
    throw new Error("Required private R2 binding FILES is unavailable.");
  }
  await ensureDemoSpeakerData(env);
  const suffix = crypto.randomUUID();
  const assetId = `demo-task-evidence-${suffix}`;
  const versionId = `demo-task-evidence-version-${suffix}`;
  const taskId = "task-demo-slides";
  const objectKey = `private/events/${DEMO_EVENT_ID}/task/${taskId}/${assetId}/${versionId}`;
  const bytes = new TextEncoder().encode(
    "%PDF-1.4\nProgram Cue deterministic local task evidence.\n%%EOF\n",
  );
  const stored = await env.FILES.put(objectKey, bytes, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: {
      eventId: DEMO_EVENT_ID,
      assetId,
      versionId,
      fixture: "golden-path-local-r2",
    },
  });
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO file_assets (
         id, event_id, owner_person_id, target_type, target_id, asset_kind,
         status, created_at, updated_at
       ) SELECT ?, ?, ?, 'task', task.id, 'task_evidence',
                'active', unixepoch(), unixepoch()
           FROM task_instances task
          WHERE task.id = ? AND task.event_id = ?
            AND task.owner_person_id = ? AND task.task_type = 'file_upload'`,
      ).bind(
        assetId,
        DEMO_EVENT_ID,
        DEMO_IDENTITIES.speaker.personId,
        taskId,
        DEMO_EVENT_ID,
        DEMO_IDENTITIES.speaker.personId,
      ),
      env.DB.prepare(
        `INSERT INTO file_versions (
         id, event_id, asset_id, version_number, object_key,
         original_filename, declared_content_type, detected_content_type,
         size_bytes, object_etag, upload_status, signature_status, scan_status,
         created_by_person_id, created_at, uploaded_at
       ) SELECT ?, ?, asset.id, 1, ?, 'golden-path-evidence.pdf',
                'application/pdf', 'application/pdf', ?, ?, 'uploaded',
                'valid', 'pending', ?, unixepoch(), unixepoch()
           FROM file_assets asset
          WHERE asset.id = ? AND asset.event_id = ?`,
      ).bind(
        versionId,
        DEMO_EVENT_ID,
        objectKey,
        bytes.byteLength,
        stored.etag,
        DEMO_IDENTITIES.speaker.personId,
        assetId,
        DEMO_EVENT_ID,
      ),
      env.DB.prepare(
        `UPDATE file_assets SET current_version_id = ?, updated_at = unixepoch()
        WHERE id = ? AND event_id = ?
          AND EXISTS (
            SELECT 1 FROM file_versions
             WHERE id = ? AND event_id = ? AND asset_id = ?
          )`,
      ).bind(
        versionId,
        assetId,
        DEMO_EVENT_ID,
        versionId,
        DEMO_EVENT_ID,
        assetId,
      ),
    ]);
  } catch (error) {
    await env.FILES.delete(objectKey);
    throw error;
  }
  if (
    (results[0]?.meta.changes ?? 0) !== 1 ||
    (results[1]?.meta.changes ?? 0) !== 1 ||
    (results[2]?.meta.changes ?? 0) !== 1
  ) {
    await env.FILES.delete(objectKey);
    throw new Error(
      "The local R2 task-evidence fixture could not be recorded.",
    );
  }
  return {
    assetId,
    versionId,
    taskId,
    filename: "golden-path-evidence.pdf",
    sizeBytes: bytes.byteLength,
    localObjectStored: true,
    providerBoundary: "local-r2-binding",
    providerCalled: true,
  };
}

async function seedAcceleventsNoWriteFixture(env: CloudflareEnvironment) {
  await ensureDemoProgramme(env);
  const message = {
    type: "integration.accelevents.export",
    operationId: ACCELEVENTS_OPERATION_ID,
    runId: ACCELEVENTS_RUN_ID,
    connectionId: ACCELEVENTS_CONNECTION_ID,
    connectionRevision: 1,
    organisationId: DEMO_ORGANISATION_ID,
    eventId: DEMO_EVENT_ID,
  };
  const diff = {
    label: "AI in Event Operations",
    payload: {
      title: "AI in Event Operations",
      description: "A deterministic no-write retry fixture.",
      startTime: "2025/05/20 10:00",
      endTime: "2025/05/20 11:00",
      format: "BREAKOUT_SESSION",
      status: "VISIBLE",
      sessionVisibilityType: "PUBLIC",
      sessionTypeFormat: "IN_PERSON",
      location: "Room 301A",
    },
    sourceHash: "0".repeat(64),
    previousExternalId: null,
    changes: [
      { field: "title", before: null, after: "AI in Event Operations" },
    ],
    providerSupport: "supported",
    providerMessage:
      "This demo-only no-write fixture intentionally returns an explicit provider-unavailable failure.",
  };
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM operation_jobs WHERE id = ? AND event_id = ?",
    ).bind(ACCELEVENTS_OPERATION_ID, DEMO_EVENT_ID),
    env.DB.prepare(
      "DELETE FROM integration_connections WHERE id = ? AND event_id = ?",
    ).bind(ACCELEVENTS_CONNECTION_ID, DEMO_EVENT_ID),
    env.DB.prepare(
      `INSERT INTO integration_connections (
         id, organisation_id, event_id, provider, status, direction,
         conflict_policy, encrypted_credentials, configuration_json,
         revision, created_at, updated_at
       ) VALUES (?, ?, ?, 'accelevents', 'connected', 'outbound',
                 'program_cue_wins', NULL, ?, 1, unixepoch(), unixepoch())`,
    ).bind(
      ACCELEVENTS_CONNECTION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      JSON.stringify({
        eventUrl: "demo-no-write-fixture",
        externalEventId: 1,
        sessionTypeFormat: "IN_PERSON",
        demoNoWriteFixture: true,
      }),
    ),
    env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json, result_json,
         progress_total, progress_completed, progress_failed, attempt_count,
         last_error, cancellable, completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'integration.accelevents.export',
                 'demo-accelevents-failed-retry', ?, 'failed', ?, NULL,
                 1, 0, 1, 1, ?, 0, unixepoch(), unixepoch(), unixepoch())`,
    ).bind(
      ACCELEVENTS_OPERATION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      "demo-accelevents-failed-correlation",
      JSON.stringify(message),
      "Demo no-write fixture: no Accelevents request was made.",
    ),
    env.DB.prepare(
      `INSERT INTO integration_runs (
         id, connection_id, operation_id, idempotency_key, status, direction,
         dry_run, summary_json, started_at, completed_at, created_at
       ) VALUES (?, ?, ?, 'demo-accelevents-failed-retry', 'failed',
                 'outbound', 0, ?, unixepoch(), unixepoch(), unixepoch())`,
    ).bind(
      ACCELEVENTS_RUN_ID,
      ACCELEVENTS_CONNECTION_ID,
      ACCELEVENTS_OPERATION_ID,
      JSON.stringify({ total: 1, create: 1, update: 0, noop: 0, blocked: 0 }),
    ),
    env.DB.prepare(
      `INSERT INTO integration_run_items (
         id, run_id, entity_type, entity_id, external_id, action, status,
         diff_json, attempt_count, error_code, error_message, updated_at
       ) VALUES (?, ?, 'session', 'demo-session-2', NULL, 'create', 'failed',
                 ?, 1, 'DEMO_NO_WRITE', ?, unixepoch())`,
    ).bind(
      ACCELEVENTS_RUN_ITEM_ID,
      ACCELEVENTS_RUN_ID,
      JSON.stringify(diff),
      "Demo no-write fixture: no Accelevents request was made.",
    ),
    env.DB.prepare(
      `INSERT INTO operation_items (
         id, operation_id, item_key, entity_type, entity_id, status,
         attempt_count, result_json, error_code, error_message,
         completed_at, updated_at
       ) VALUES (?, ?, 'session:demo-session-2', 'session', 'demo-session-2',
                 'failed', 1, ?, 'DEMO_NO_WRITE', ?, unixepoch(), unixepoch())`,
    ).bind(
      ACCELEVENTS_OPERATION_ITEM_ID,
      ACCELEVENTS_OPERATION_ID,
      JSON.stringify(diff),
      "Demo no-write fixture: no Accelevents request was made.",
    ),
  ]);
  return {
    connectionId: ACCELEVENTS_CONNECTION_ID,
    operationId: ACCELEVENTS_OPERATION_ID,
    itemId: ACCELEVENTS_OPERATION_ITEM_ID,
    providerBoundary: "accelevents",
    providerCalled: false,
  };
}

async function seedEventRepositoryRecovery(env: CloudflareEnvironment) {
  await ensureDemoProgramme(env);
  await env.DB.prepare("DELETE FROM events WHERE id = ?")
    .bind(REPOSITORY_RECOVERY_EVENT_ID)
    .run();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         brand_accent, brand_draft_accent,
         repository_provider, activation_status, file_policy_json,
         last_operation_id, last_updated_by_person_id
       ) VALUES (?, ?, 'Airtable recovery browser fixture',
                 'airtable-recovery-browser-fixture', 'America/Toronto',
                 1800000000, 1800086400, ?, ?, 'airtable',
                 'provisioning_failed', ?, ?, ?)`,
    ).bind(
      REPOSITORY_RECOVERY_EVENT_ID,
      DEMO_ORGANISATION_ID,
      DEFAULT_EVENT_BRAND_ACCENT,
      DEFAULT_EVENT_BRAND_ACCENT,
      CANONICAL_EVENT_FILE_POLICY_JSON,
      REPOSITORY_RECOVERY_OPERATION_ID,
      DEMO_IDENTITIES.administrator.personId,
    ),
    env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         progress_total, progress_completed, progress_failed, cancellable,
         last_error, started_at, completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'event.create',
                 'demo-airtable-recovery-failed', ?, 'failed', ?,
                 1, 0, 1, 0, 'Demo fixture: Airtable provisioning failed; no provider request was made.',
                 unixepoch(), unixepoch(), unixepoch(), unixepoch())`,
    ).bind(
      REPOSITORY_RECOVERY_OPERATION_ID,
      DEMO_ORGANISATION_ID,
      REPOSITORY_RECOVERY_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      "demo-airtable-recovery-failed-correlation",
      JSON.stringify({
        type: "event.create",
        targetEventId: REPOSITORY_RECOVERY_EVENT_ID,
        requestedRepositoryProvider: "airtable",
        demonstrationOnly: true,
        providerCalled: false,
      }),
    ),
  ]);
  return {
    eventId: REPOSITORY_RECOVERY_EVENT_ID,
    operationId: REPOSITORY_RECOVERY_OPERATION_ID,
    recoveryPath: `/admin/events/${REPOSITORY_RECOVERY_EVENT_ID}/repository-recovery`,
    providerBoundary: "airtable",
    providerCalled: false,
  };
}

async function seedNonActionableFailureAlert(env: CloudflareEnvironment) {
  await ensureDemoProgramme(env);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM audit_events
        WHERE event_id = ? AND entity_type = 'operation' AND entity_id = ?`,
    ).bind(DEMO_EVENT_ID, FAILURE_ALERT_OPERATION_ID),
    env.DB.prepare(
      `DELETE FROM operation_jobs WHERE id = ? AND event_id = ?`,
    ).bind(FAILURE_ALERT_OPERATION_ID, DEMO_EVENT_ID),
    env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json, result_json,
         progress_total, progress_completed, progress_failed, attempt_count,
         last_error, cancellable, completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'ai.context.run',
                 'demo-non-actionable-failed-operation', ?, 'failed', ?, ?,
                 1, 0, 1, 1, ?, 0, unixepoch(), unixepoch(), unixepoch())`,
    ).bind(
      FAILURE_ALERT_OPERATION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      "demo-non-actionable-failed-correlation",
      JSON.stringify({
        runId: FAILURE_ALERT_OPERATION_ID,
        kind: "readiness_summary",
        demonstrationOnly: true,
      }),
      JSON.stringify({ errorType: "DemoHistoricalFailure" }),
      "Demo fixture: a historical AI context run failed before the bug was corrected.",
    ),
  ]);
  return {
    operationId: FAILURE_ALERT_OPERATION_ID,
    operationType: "ai.context.run",
    providerCalled: false,
  };
}

async function seedFailureAlertPagination(env: CloudflareEnvironment) {
  await ensureDemoProgramme(env);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM audit_events
        WHERE event_id = ? AND entity_type = 'operation'
          AND entity_id LIKE ?`,
    ).bind(DEMO_EVENT_ID, `${FAILURE_PAGINATION_PREFIX}%`),
    env.DB.prepare(
      `DELETE FROM operation_jobs
        WHERE event_id = ? AND id LIKE ?`,
    ).bind(DEMO_EVENT_ID, `${FAILURE_PAGINATION_PREFIX}%`),
    env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         VALUES (1)
         UNION ALL SELECT value + 1 FROM sequence WHERE value < 51
       )
       INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json, last_error,
         cancellable, completed_at, created_at, updated_at
       )
       SELECT printf('%s%03d', ?, value), ?, ?, ?, ?,
              printf('%skey-%03d', ?, value),
              printf('%scorrelation-%03d', ?, value),
              'failed', '{}', 'Demo fixture: paginated historical failure.',
              0, value, value, value
         FROM sequence`,
    ).bind(
      FAILURE_PAGINATION_PREFIX,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      FAILURE_PAGINATION_TYPE,
      FAILURE_PAGINATION_PREFIX,
      FAILURE_PAGINATION_PREFIX,
    ),
  ]);
  return {
    operationType: FAILURE_PAGINATION_TYPE,
    operationCount: 51,
    providerCalled: false,
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const { env } = getCloudflareContext(context);
  requireDemo(env);
  if (request.method !== "POST") return methodNotAllowed();
  const form = await request.formData();
  if (form.get("confirm") !== CONFIRMATION) {
    throw new Response("Explicit demo fixture confirmation is required", {
      status: 400,
    });
  }
  const intent = form.get("intent");
  const result =
    intent === "seed_task_evidence"
      ? await seedTaskEvidence(env)
      : intent === "seed_accelevents_no_write"
        ? await seedAcceleventsNoWriteFixture(env)
        : intent === "seed_event_repository_recovery"
          ? await seedEventRepositoryRecovery(env)
          : intent === "seed_non_actionable_failure_alert"
            ? await seedNonActionableFailureAlert(env)
            : intent === "seed_failure_alert_pagination"
              ? await seedFailureAlertPagination(env)
              : null;
  if (!result)
    throw new Response("Unsupported demo fixture action", { status: 400 });
  return data(
    {
      ok: true,
      demonstrationOnly: true,
      ...result,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
