import {
  decryptWebhookSecret,
  signWebhookPayload,
} from "../../app/platform/operations/webhook-crypto.server";
import {
  resolveWebhookHostname,
  validateWebhookDestination,
  type WebhookHostnameResolver,
} from "../../app/platform/operations/webhook-endpoint-service.server";
import { webhookDeliveryMessageSchema } from "../../app/platform/operations/webhook-schema";
import {
  loadOperationClaim,
  notifyRealtimeAfterCommit,
  QUEUE_CLAIM_LEASE_SECONDS,
  QueueClaimLeaseBusyError,
  returnedChangeSequence,
} from "./claim-infrastructure";

type WebhookEnvironment = CloudflareEnvironment & {
  WEBHOOK_CREDENTIALS_KEY?: string;
};

type WebhookDeliveryRecord = {
  deliveryId: string;
  deliveryStatus: string;
  eventType: string;
  payloadJson: string;
  endpointId: string;
  endpointStatus: string;
  endpointUrl: string;
  secretCiphertext: string;
  operationStatus: string;
  operationPayloadJson: string;
};

async function responseExcerpt(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  try {
    while (result.length < 1_000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      result += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return result.slice(0, 1_000);
}

function responseHeaders(response: Response) {
  return JSON.stringify(
    Object.fromEntries(
      ["content-type", "retry-after", "x-request-id", "cf-ray"]
        .map((name) => [name, response.headers.get(name)] as const)
        .filter((entry): entry is [string, string] => entry[1] !== null),
    ),
  );
}

async function finishFailure(input: {
  env: WebhookEnvironment;
  message: ReturnType<typeof webhookDeliveryMessageSchema.parse>;
  record: WebhookDeliveryRecord;
  claimToken: string;
  startedAt: number;
  response?: Response;
  error: unknown;
}) {
  const { env, message, record, claimToken, startedAt, response, error } =
    input;
  const messageText = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, 2_000);
  const errorCode = (
    response
      ? `HTTP_${response.status}`
      : error instanceof Error
        ? error.name
        : "WEBHOOK_REQUEST_FAILED"
  ).slice(0, 120);
  const excerpt = response ? await responseExcerpt(response) : null;
  const results = await env.DB.batch([
    env.DB.prepare(
      `
      INSERT INTO webhook_delivery_attempts (
        id, delivery_id, attempt_number, request_timestamp, response_status,
        response_headers_json, response_excerpt, error_message, duration_ms,
        created_at
      )
      SELECT ?, ?, wd.attempt_count, ?, ?, ?, ?, ?, ?, unixepoch()
        FROM webhook_deliveries wd
        JOIN operation_items oi ON oi.entity_id = wd.id
       WHERE wd.id = ? AND oi.operation_id = ? AND wd.status = 'delivering'
         AND EXISTS (
           SELECT 1 FROM operation_jobs o
            WHERE o.id = oi.operation_id AND o.event_id = ?
              AND o.status = 'running' AND o.claim_token = ?
         )
    `,
    ).bind(
      crypto.randomUUID(),
      message.deliveryId,
      startedAt,
      response?.status ?? null,
      response ? responseHeaders(response) : null,
      excerpt,
      messageText,
      Math.max(0, Date.now() - startedAt * 1_000),
      message.deliveryId,
      message.operationId,
      message.eventId,
      claimToken,
    ),
    env.DB.prepare(
      `
      UPDATE webhook_deliveries
         SET status = 'failed', next_attempt_at = NULL, updated_at = unixepoch()
       WHERE id = ? AND endpoint_id = ? AND status = 'delivering'
         AND EXISTS (
           SELECT 1 FROM operation_jobs o
            WHERE o.id = ? AND o.event_id = ? AND o.organisation_id = ?
              AND o.status = 'running' AND o.claim_token = ?
         )
    `,
    ).bind(
      message.deliveryId,
      record.endpointId,
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
    ),
    env.DB.prepare(
      `
      UPDATE webhook_endpoints
         SET status = CASE WHEN status = 'disabled' THEN status ELSE 'failing' END,
             failure_count = failure_count + 1, updated_at = unixepoch()
       WHERE id = ? AND event_id = ?
         AND EXISTS (
           SELECT 1 FROM webhook_deliveries wd
            WHERE wd.id = ? AND wd.endpoint_id = webhook_endpoints.id
              AND wd.status = 'failed'
         )
    `,
    ).bind(record.endpointId, message.eventId, message.deliveryId),
    env.DB.prepare(
      `
      UPDATE operation_items
         SET status = 'failed', error_code = ?, error_message = ?,
             completed_at = unixepoch(), updated_at = unixepoch()
       WHERE operation_id = ? AND entity_type = 'webhook_delivery'
         AND entity_id = ? AND status = 'running'
         AND EXISTS (
           SELECT 1 FROM operation_jobs o
            WHERE o.id = operation_items.operation_id AND o.event_id = ?
              AND o.status = 'running' AND o.claim_token = ?
         )
    `,
    ).bind(
      errorCode,
      messageText,
      message.operationId,
      message.deliveryId,
      message.eventId,
      claimToken,
    ),
    env.DB.prepare(
      `
      UPDATE operation_jobs
         SET status = 'failed', progress_total = 1, progress_completed = 1,
             progress_failed = 1, last_error = ?, result_json = ?,
             completed_at = unixepoch(), claim_token = NULL,
             claim_expires_at = NULL, updated_at = unixepoch()
       WHERE id = ? AND event_id = ? AND organisation_id = ?
         AND type = 'webhook.deliver' AND status = 'running'
         AND claim_token = ?
         AND EXISTS (
           SELECT 1 FROM webhook_deliveries wd
            WHERE wd.id = ? AND wd.status = 'failed'
         )
    `,
    ).bind(
      messageText,
      JSON.stringify({
        deliveryId: message.deliveryId,
        endpointId: record.endpointId,
        errorCode,
      }),
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
      message.deliveryId,
    ),
    env.DB.prepare(
      `
      INSERT INTO audit_events (
        id, actor_kind, origin, metadata_version, organisation_id, event_id, action, entity_type, entity_id,
        metadata_json, created_at
      )
      SELECT ?, 'system', 'queue', 1, ?, ?, 'webhook.delivery_failed', 'webhook_delivery', ?, ?, unixepoch()
       WHERE EXISTS (
         SELECT 1 FROM operation_jobs o
          WHERE o.id = ? AND o.event_id = ? AND o.status = 'failed'
       )
    `,
    ).bind(
      crypto.randomUUID(),
      message.organisationId,
      message.eventId,
      message.deliveryId,
      JSON.stringify({
        operationId: message.operationId,
        endpointId: record.endpointId,
        errorCode,
      }),
      message.operationId,
      message.eventId,
    ),
    env.DB.prepare(
      `
      INSERT INTO event_changes (
        event_id, entity_type, entity_id, change_type, correlation_id, created_at
      )
      SELECT ?, 'operation', ?, 'progress', o.correlation_id, unixepoch()
        FROM operation_jobs o
       WHERE o.id = ? AND o.event_id = ? AND o.status = 'failed'
      RETURNING sequence
    `,
    ).bind(
      message.eventId,
      message.operationId,
      message.operationId,
      message.eventId,
    ),
  ]);
  if ((results[4].meta.changes ?? 0) !== 1) {
    throw new Error(
      "The webhook failure could not be recorded under the active operation claim.",
    );
  }
  await notifyRealtimeAfterCommit(
    env,
    { organisationId: message.organisationId, eventId: message.eventId },
    returnedChangeSequence(results[6]),
    message.operationId,
  );
}

export async function processWebhookDelivery(
  input: unknown,
  env: WebhookEnvironment,
  fetcher: typeof fetch = fetch,
  resolveHostname: WebhookHostnameResolver = resolveWebhookHostname,
) {
  const message = webhookDeliveryMessageSchema.parse(input);
  let record = await env.DB.prepare(
    `
    SELECT wd.id AS deliveryId, wd.status AS deliveryStatus,
           wd.event_type AS eventType,
           wd.payload_json AS payloadJson, we.id AS endpointId,
           we.status AS endpointStatus, we.url AS endpointUrl,
           we.secret_ciphertext AS secretCiphertext,
           o.status AS operationStatus, o.payload_json AS operationPayloadJson
      FROM webhook_deliveries wd
      JOIN webhook_endpoints we ON we.id = wd.endpoint_id
      JOIN events e ON e.id = we.event_id AND e.organisation_id = ?
      JOIN operation_items oi ON oi.entity_type = 'webhook_delivery'
        AND oi.entity_id = wd.id
      JOIN operation_jobs o ON o.id = oi.operation_id AND o.event_id = we.event_id
     WHERE wd.id = ? AND we.event_id = ? AND o.id = ?
       AND o.type = 'webhook.deliver' AND o.idempotency_key = ?
     LIMIT 1
  `,
  )
    .bind(
      message.organisationId,
      message.deliveryId,
      message.eventId,
      message.operationId,
      message.idempotencyKey,
    )
    .first<WebhookDeliveryRecord>();
  if (!record) {
    throw new Error(
      "Webhook delivery does not exist in the authorised operation scope.",
    );
  }
  const savedMessage = webhookDeliveryMessageSchema.safeParse(
    JSON.parse(record.operationPayloadJson),
  );
  if (
    !savedMessage.success ||
    JSON.stringify(savedMessage.data) !== JSON.stringify(message)
  ) {
    throw new Error(
      "The webhook Queue message does not match its durable operation payload.",
    );
  }
  if (
    ["completed", "cancelled", "failed", "partially_failed"].includes(
      record.operationStatus,
    )
  ) {
    return;
  }
  const claimToken = crypto.randomUUID();
  const startedAt = Math.floor(Date.now() / 1_000);
  const claims = await env.DB.batch([
    env.DB.prepare(
      `
      UPDATE operation_jobs
         SET status = 'running', started_at = COALESCE(started_at, unixepoch()),
             attempt_count = attempt_count + 1, last_error = NULL,
             completed_at = NULL, claim_token = ?,
             claim_expires_at = unixepoch() + ?, updated_at = unixepoch()
       WHERE id = ? AND event_id = ? AND organisation_id = ?
         AND type = 'webhook.deliver' AND idempotency_key = ?
         AND (
           status IN ('queued','received','retrying','queue_failed')
           OR (status = 'running' AND COALESCE(claim_expires_at, 0) <= unixepoch())
         )
    `,
    ).bind(
      claimToken,
      QUEUE_CLAIM_LEASE_SECONDS,
      message.operationId,
      message.eventId,
      message.organisationId,
      message.idempotencyKey,
    ),
    env.DB.prepare(
      `
      UPDATE webhook_deliveries
         SET status = 'delivering', attempt_count = attempt_count + 1,
             next_attempt_at = NULL, updated_at = unixepoch()
       WHERE id = ? AND endpoint_id = ? AND status IN ('queued','failed','delivering')
         AND EXISTS (
           SELECT 1 FROM operation_jobs o
            WHERE o.id = ? AND o.event_id = ? AND o.status = 'running'
              AND o.claim_token = ?
         )
    `,
    ).bind(
      message.deliveryId,
      record.endpointId,
      message.operationId,
      message.eventId,
      claimToken,
    ),
    env.DB.prepare(
      `
      UPDATE operation_items
         SET status = 'running', attempt_count = attempt_count + 1,
             error_code = NULL, error_message = NULL,
             started_at = unixepoch(), completed_at = NULL,
             updated_at = unixepoch()
       WHERE operation_id = ? AND entity_type = 'webhook_delivery'
         AND entity_id = ? AND status IN ('pending','failed','running')
         AND EXISTS (
           SELECT 1 FROM operation_jobs o
            WHERE o.id = operation_items.operation_id AND o.event_id = ?
              AND o.status = 'running' AND o.claim_token = ?
         )
    `,
    ).bind(
      message.operationId,
      message.deliveryId,
      message.eventId,
      claimToken,
    ),
  ]);
  if (claims.every((claim) => (claim.meta.changes ?? 0) === 0)) {
    const current = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (
      current &&
      ["completed", "cancelled", "failed", "partially_failed"].includes(
        current.status,
      )
    ) {
      return;
    }
    if (
      current?.status === "running" &&
      current.claimToken &&
      (current.claimExpiresAt ?? 0) > Math.floor(Date.now() / 1_000)
    ) {
      throw new QueueClaimLeaseBusyError();
    }
  }
  if (!claims.every((claim) => (claim.meta.changes ?? 0) === 1)) {
    throw new Error(
      "The webhook delivery claim could not be recorded consistently.",
    );
  }

  // Endpoint status, URL, and signing authority are mutable. Resolve them
  // again after the operation claim so a completed disable or secret rotation
  // cannot be bypassed by a stale pre-claim read.
  const claimedEndpoint = await env.DB.prepare(
    `SELECT we.status AS endpointStatus, we.url AS endpointUrl,
            we.secret_ciphertext AS secretCiphertext
       FROM webhook_endpoints we
       JOIN webhook_deliveries delivery
         ON delivery.endpoint_id = we.id AND delivery.id = ?
       JOIN operation_items item
         ON item.operation_id = ? AND item.entity_type = 'webhook_delivery'
        AND item.entity_id = delivery.id
       JOIN operation_jobs operation
         ON operation.id = item.operation_id AND operation.event_id = we.event_id
        AND operation.organisation_id = we.organisation_id
        AND operation.status = 'running' AND operation.claim_token = ?
      WHERE we.id = ? AND we.event_id = ? AND we.organisation_id = ?`,
  )
    .bind(
      message.deliveryId,
      message.operationId,
      claimToken,
      record.endpointId,
      message.eventId,
      message.organisationId,
    )
    .first<
      Pick<
        WebhookDeliveryRecord,
        "endpointStatus" | "endpointUrl" | "secretCiphertext"
      >
    >();
  if (!claimedEndpoint) {
    throw new Error(
      "The webhook endpoint authority could not be resolved for the claimed delivery.",
    );
  }
  record = { ...record, ...claimedEndpoint };

  if (record.endpointStatus === "disabled") {
    await finishFailure({
      env,
      message,
      record,
      claimToken,
      startedAt,
      error: new Error("The webhook endpoint was disabled before delivery."),
    });
    return;
  }

  let response: Response;
  try {
    const endpointUrl = await validateWebhookDestination(
      record.endpointUrl,
      resolveHostname,
    );
    const timestamp = Math.floor(Date.now() / 1_000);
    const secret = await decryptWebhookSecret(
      record.secretCiphertext,
      record.endpointId,
      env.WEBHOOK_CREDENTIALS_KEY,
      env.WEBHOOK_CREDENTIALS_PREVIOUS_KEY,
    );
    const signature = await signWebhookPayload(
      secret,
      timestamp,
      record.payloadJson,
    );
    // Application profiles require global_fetch_strictly_public. Cloudflare's
    // outbound proxy therefore enforces the actual connection destination as
    // public after DNS resolution, closing the preflight-to-fetch rebinding gap.
    response = await fetcher(endpointUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "program-cue-delivery": message.deliveryId,
        "program-cue-event": record.eventType,
        "program-cue-timestamp": String(timestamp),
        "program-cue-signature": `v1=${signature}`,
      },
      body: record.payloadJson,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    await finishFailure({
      env,
      message,
      record,
      claimToken,
      startedAt,
      error,
    });
    return;
  }

  if (response.status < 200 || response.status >= 300) {
    await finishFailure({
      env,
      message,
      record,
      claimToken,
      startedAt,
      response,
      error: new Error(`Webhook endpoint returned HTTP ${response.status}.`),
    });
    return;
  }
  const excerpt = await responseExcerpt(response);
  const results = await env.DB.batch([
    env.DB.prepare(
      `
      INSERT INTO webhook_delivery_attempts (
        id, delivery_id, attempt_number, request_timestamp, response_status,
        response_headers_json, response_excerpt, duration_ms, created_at
      )
      SELECT ?, ?, wd.attempt_count, ?, ?, ?, ?, ?, unixepoch()
        FROM webhook_deliveries wd
       WHERE wd.id = ? AND wd.status = 'delivering'
         AND EXISTS (
           SELECT 1 FROM operation_jobs o
            WHERE o.id = ? AND o.event_id = ? AND o.status = 'running'
              AND o.claim_token = ?
         )
    `,
    ).bind(
      crypto.randomUUID(),
      message.deliveryId,
      startedAt,
      response.status,
      responseHeaders(response),
      excerpt,
      Math.max(0, Date.now() - startedAt * 1_000),
      message.deliveryId,
      message.operationId,
      message.eventId,
      claimToken,
    ),
    env.DB.prepare(
      `
      UPDATE webhook_deliveries
         SET status = 'delivered', delivered_at = unixepoch(),
             next_attempt_at = NULL, updated_at = unixepoch()
       WHERE id = ? AND endpoint_id = ? AND status = 'delivering'
         AND EXISTS (
           SELECT 1 FROM operation_jobs o
            WHERE o.id = ? AND o.event_id = ? AND o.organisation_id = ?
              AND o.status = 'running' AND o.claim_token = ?
         )
    `,
    ).bind(
      message.deliveryId,
      record.endpointId,
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
    ),
    env.DB.prepare(
      `UPDATE webhook_endpoints
          SET status = 'active', failure_count = 0, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND status <> 'disabled'
          AND EXISTS (SELECT 1 FROM webhook_deliveries WHERE id = ? AND status = 'delivered')`,
    ).bind(record.endpointId, message.eventId, message.deliveryId),
    env.DB.prepare(
      `
      UPDATE operation_items
         SET status = 'completed', result_json = ?, completed_at = unixepoch(),
             updated_at = unixepoch()
       WHERE operation_id = ? AND entity_type = 'webhook_delivery'
         AND entity_id = ? AND status = 'running'
         AND EXISTS (
           SELECT 1 FROM operation_jobs o
            WHERE o.id = operation_items.operation_id AND o.event_id = ?
              AND o.status = 'running' AND o.claim_token = ?
         )
    `,
    ).bind(
      JSON.stringify({
        endpointId: record.endpointId,
        responseStatus: response.status,
      }),
      message.operationId,
      message.deliveryId,
      message.eventId,
      claimToken,
    ),
    env.DB.prepare(
      `
      UPDATE operation_jobs
         SET status = 'completed', progress_total = 1, progress_completed = 1,
             progress_failed = 0, last_error = NULL, result_json = ?,
             completed_at = unixepoch(), claim_token = NULL,
             claim_expires_at = NULL, updated_at = unixepoch()
       WHERE id = ? AND event_id = ? AND organisation_id = ?
         AND status = 'running' AND claim_token = ?
         AND EXISTS (SELECT 1 FROM webhook_deliveries WHERE id = ? AND status = 'delivered')
    `,
    ).bind(
      JSON.stringify({
        deliveryId: message.deliveryId,
        endpointId: record.endpointId,
        responseStatus: response.status,
      }),
      message.operationId,
      message.eventId,
      message.organisationId,
      claimToken,
      message.deliveryId,
    ),
    env.DB.prepare(
      `
      INSERT INTO audit_events (
        id, actor_kind, origin, metadata_version, organisation_id, event_id, action, entity_type, entity_id,
        metadata_json, created_at
      )
      SELECT ?, 'system', 'queue', 1, ?, ?, 'webhook.delivered', 'webhook_delivery', ?, ?, unixepoch()
       WHERE EXISTS (
         SELECT 1 FROM operation_jobs o
          WHERE o.id = ? AND o.event_id = ? AND o.status = 'completed'
       )
    `,
    ).bind(
      crypto.randomUUID(),
      message.organisationId,
      message.eventId,
      message.deliveryId,
      JSON.stringify({
        operationId: message.operationId,
        endpointId: record.endpointId,
        responseStatus: response.status,
      }),
      message.operationId,
      message.eventId,
    ),
    env.DB.prepare(
      `
      INSERT INTO event_changes (
        event_id, entity_type, entity_id, change_type, correlation_id, created_at
      )
      SELECT ?, 'operation', ?, 'progress', o.correlation_id, unixepoch()
        FROM operation_jobs o
       WHERE o.id = ? AND o.event_id = ? AND o.status = 'completed'
      RETURNING sequence
    `,
    ).bind(
      message.eventId,
      message.operationId,
      message.operationId,
      message.eventId,
    ),
  ]);
  if ((results[4].meta.changes ?? 0) !== 1) {
    throw new Error(
      "The webhook success could not be recorded under the active operation claim.",
    );
  }
  await notifyRealtimeAfterCommit(
    env,
    { organisationId: message.organisationId, eventId: message.eventId },
    returnedChangeSequence(results[6]),
    message.operationId,
  );
}
