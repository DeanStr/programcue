import {
  activeCalendarCredentialKeyId,
  calendarCredentialGeneration,
  decryptCalendarCredentials,
  encryptCalendarCredentials,
} from "~/modules/calendars/calendar-providers.server";
import {
  activeIntegrationCredentialKeyId,
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
} from "~/modules/integrations/integration-credentials.server";
import { apiRequestHash } from "~/platform/api/api.server";
import {
  activeWebhookCredentialKeyId,
  decryptWebhookSecret,
  encryptWebhookSecret,
} from "~/platform/operations/webhook-crypto.server";

const REWRAP_BATCH_SIZE = 100;

type RewrapResult = {
  calendar: number;
  integrations: number;
  webhooks: number;
  remaining: number;
};

async function rewrapCalendarCredentials(
  env: CloudflareEnvironment,
  activeKeyId: string,
) {
  const rows = await env.DB.prepare(
    `SELECT id, organisation_id AS organisationId, provider,
            encrypted_credentials AS encryptedCredentials
      FROM calendar_connections
      WHERE encrypted_credentials IS NOT NULL
        AND CASE
              WHEN json_valid(encrypted_credentials) THEN COALESCE(
                json_extract(encrypted_credentials, '$.version') = 2
                AND json_extract(encrypted_credentials, '$.keyId') = ?,
                0
              )
              ELSE 0
            END = 0
      ORDER BY updated_at, id
      LIMIT ?`,
  )
    .bind(activeKeyId, REWRAP_BATCH_SIZE)
    .all<{
      id: string;
      organisationId: string;
      provider: "google" | "microsoft";
      encryptedCredentials: string;
    }>();
  let rewrapped = 0;
  for (const row of rows.results) {
    const context = {
      connectionId: row.id,
      organisationId: row.organisationId,
      provider: row.provider,
    } as const;
    const credentials = await decryptCalendarCredentials(
      row.encryptedCredentials,
      env.CALENDAR_CREDENTIALS_KEY,
      context,
      env.CALENDAR_CREDENTIALS_PREVIOUS_KEY,
    );
    const ciphertext = await encryptCalendarCredentials(
      credentials,
      env.CALENDAR_CREDENTIALS_KEY,
      context,
      await calendarCredentialGeneration(row.encryptedCredentials),
    );
    const updated = await env.DB.prepare(
      `UPDATE calendar_connections
          SET encrypted_credentials = ?, updated_at = unixepoch()
        WHERE id = ? AND organisation_id = ? AND encrypted_credentials = ?`,
    )
      .bind(ciphertext, row.id, row.organisationId, row.encryptedCredentials)
      .run();
    rewrapped += updated.meta.changes ?? 0;
  }
  return rewrapped;
}

async function rewrapIntegrationCredentials(
  env: CloudflareEnvironment,
  activeKeyId: string,
) {
  const rows = await env.DB.prepare(
    `SELECT id, organisation_id AS organisationId,
            encrypted_credentials AS encryptedCredentials
      FROM integration_connections
      WHERE encrypted_credentials IS NOT NULL
        AND CASE
              WHEN json_valid(encrypted_credentials) THEN COALESCE(
                json_extract(encrypted_credentials, '$.version') = 2
                AND json_extract(encrypted_credentials, '$.keyId') = ?,
                0
              )
              ELSE 0
            END = 0
      ORDER BY updated_at, id
      LIMIT ?`,
  )
    .bind(activeKeyId, REWRAP_BATCH_SIZE)
    .all<{
      id: string;
      organisationId: string;
      encryptedCredentials: string;
    }>();
  let rewrapped = 0;
  for (const row of rows.results) {
    const credentials = await decryptIntegrationCredentials(
      row.encryptedCredentials,
      env.INTEGRATION_CREDENTIALS_KEY,
      row.id,
      env.INTEGRATION_CREDENTIALS_PREVIOUS_KEY,
    );
    const ciphertext = await encryptIntegrationCredentials(
      credentials,
      env.INTEGRATION_CREDENTIALS_KEY,
      row.id,
    );
    const updated = await env.DB.prepare(
      `UPDATE integration_connections
          SET encrypted_credentials = ?, updated_at = unixepoch()
        WHERE id = ? AND organisation_id = ? AND encrypted_credentials = ?`,
    )
      .bind(ciphertext, row.id, row.organisationId, row.encryptedCredentials)
      .run();
    rewrapped += updated.meta.changes ?? 0;
  }
  return rewrapped;
}

async function rewrapWebhookCredentials(
  env: CloudflareEnvironment,
  activeKeyId: string,
) {
  const activePrefix = `v2:${activeKeyId}:`;
  const rows = await env.DB.prepare(
    `SELECT id, organisation_id AS organisationId, event_id AS eventId,
            secret_ciphertext AS secretCiphertext
      FROM webhook_endpoints
      WHERE substr(secret_ciphertext, 1, length(?)) <> ?
        AND secret_ciphertext NOT LIKE 'retained-%'
      ORDER BY updated_at, id
      LIMIT ?`,
  )
    .bind(activePrefix, activePrefix, REWRAP_BATCH_SIZE)
    .all<{
      id: string;
      organisationId: string;
      eventId: string | null;
      secretCiphertext: string;
    }>();
  let rewrapped = 0;
  for (const row of rows.results) {
    const secret = await decryptWebhookSecret(
      row.secretCiphertext,
      row.id,
      env.WEBHOOK_CREDENTIALS_KEY,
      env.WEBHOOK_CREDENTIALS_PREVIOUS_KEY,
    );
    const ciphertext = await encryptWebhookSecret(
      secret,
      row.id,
      env.WEBHOOK_CREDENTIALS_KEY,
    );
    const [, updated] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE idempotency_records
            SET response_json = json_set(
              response_json,
              '$.secretFingerprint', ?,
              '$.secretFingerprintVersion', 2
            )
          WHERE organisation_id = ? AND event_id IS ?
            AND scope IN (
              'api.webhook-endpoint.save',
              'api.webhook-endpoint.rotate-secret'
            )
            AND status = 'completed' AND expires_at > unixepoch()
            AND json_valid(response_json)
            AND json_extract(response_json, '$.endpointId') = ?
            AND json_type(response_json, '$.secretFingerprintVersion') IS NULL
            AND json_extract(response_json, '$.secretFingerprint') = ?`,
      ).bind(
        await apiRequestHash(secret),
        row.organisationId,
        row.eventId,
        row.id,
        await apiRequestHash(row.secretCiphertext),
      ),
      env.DB.prepare(
        `UPDATE webhook_endpoints
          SET secret_ciphertext = ?, updated_at = unixepoch()
        WHERE id = ? AND organisation_id = ? AND secret_ciphertext = ?`,
      ).bind(ciphertext, row.id, row.organisationId, row.secretCiphertext),
    ]);
    rewrapped += updated.meta.changes ?? 0;
  }
  return rewrapped;
}

export function providerCredentialRotationActive(env: CloudflareEnvironment) {
  return Boolean(
    env.CALENDAR_CREDENTIALS_PREVIOUS_KEY?.trim() ||
      env.INTEGRATION_CREDENTIALS_PREVIOUS_KEY?.trim() ||
      env.WEBHOOK_CREDENTIALS_PREVIOUS_KEY?.trim(),
  );
}

export async function rewrapProviderCredentials(
  env: CloudflareEnvironment,
): Promise<RewrapResult> {
  const [calendarKeyId, integrationKeyId, webhookKeyId] = await Promise.all([
    activeCalendarCredentialKeyId(env.CALENDAR_CREDENTIALS_KEY),
    activeIntegrationCredentialKeyId(env.INTEGRATION_CREDENTIALS_KEY),
    activeWebhookCredentialKeyId(env.WEBHOOK_CREDENTIALS_KEY),
  ]);
  const calendar = await rewrapCalendarCredentials(env, calendarKeyId);
  const integrations = await rewrapIntegrationCredentials(
    env,
    integrationKeyId,
  );
  const webhooks = await rewrapWebhookCredentials(env, webhookKeyId);
  const calendarCurrent = `CASE
    WHEN json_valid(encrypted_credentials) THEN COALESCE(
      json_extract(encrypted_credentials, '$.version') = 2
      AND json_extract(encrypted_credentials, '$.keyId') = ?,
      0
    )
    ELSE 0
  END`;
  const integrationCurrent = calendarCurrent;
  const webhookPrefix = `v2:${webhookKeyId}:`;
  const remaining = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM calendar_connections
         WHERE encrypted_credentials IS NOT NULL
           AND (${calendarCurrent}) = 0) +
       (SELECT COUNT(*) FROM integration_connections
         WHERE encrypted_credentials IS NOT NULL
           AND (${integrationCurrent}) = 0) +
       (SELECT COUNT(*) FROM webhook_endpoints
         WHERE substr(secret_ciphertext, 1, length(?)) <> ?
           AND secret_ciphertext NOT LIKE 'retained-%') AS remaining`,
  )
    .bind(calendarKeyId, integrationKeyId, webhookPrefix, webhookPrefix)
    .first<{ remaining: number }>();
  return {
    calendar,
    integrations,
    webhooks,
    remaining: remaining?.remaining ?? 0,
  };
}
