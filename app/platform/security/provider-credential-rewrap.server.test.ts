import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
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
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
} from "~/platform/operations/webhook-crypto.server";

import {
  providerCredentialRotationActive,
  rewrapProviderCredentials,
} from "./provider-credential-rewrap.server";

function credentialKey(offset: number) {
  return btoa(
    String.fromCharCode(
      ...Array.from({ length: 32 }, (_, index) => (index + offset) % 256),
    ),
  );
}

const previousKey = credentialKey(0);
const activeKey = credentialKey(73);

function base64(bytes: Uint8Array, urlSafe = false) {
  const encoded = btoa(String.fromCharCode(...bytes));
  return urlSafe
    ? encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
    : encoded;
}

async function legacyCiphertext(
  plaintext: string,
  keyValue: string,
  additionalData?: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(keyValue), (character) => character.charCodeAt(0)),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        ...(additionalData
          ? { additionalData: new TextEncoder().encode(additionalData) }
          : {}),
      },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  return { iv, ciphertext };
}

describe("provider credential rotation", () => {
  beforeEach(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
  });

  it("binds current calendar envelopes to their owning context", async () => {
    const context = {
      connectionId: "calendar-context-1",
      organisationId: "org-future-events",
      provider: "google" as const,
    };
    const ciphertext = await encryptCalendarCredentials(
      {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        accessTokenExpiresAt: 2_000_000_000,
        tokenType: "Bearer",
      },
      activeKey,
      context,
    );
    await expect(
      decryptCalendarCredentials(ciphertext, activeKey, {
        ...context,
        connectionId: "calendar-context-2",
      }),
    ).rejects.toThrow("could not be decrypted");

    const delimiterContext = {
      connectionId: "connection",
      organisationId: "organisation:segment",
      provider: "google" as const,
    };
    const delimiterCiphertext = await encryptCalendarCredentials(
      {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        accessTokenExpiresAt: 2_000_000_000,
        tokenType: "Bearer",
      },
      activeKey,
      delimiterContext,
    );
    await expect(
      decryptCalendarCredentials(delimiterCiphertext, activeKey, {
        connectionId: "segment:connection",
        organisationId: "organisation",
        provider: "google",
      }),
    ).rejects.toThrow("could not be decrypted");
  });

  it("keeps deployed version-one envelopes readable during migration", async () => {
    const context = {
      connectionId: "calendar-legacy-1",
      organisationId: "org-future-events",
      provider: "google" as const,
    };
    const calendarCredentials = {
      accessToken: "legacy-access-token",
      refreshToken: "legacy-refresh-token",
      accessTokenExpiresAt: 2_000_000_000,
      tokenType: "Bearer" as const,
    };
    const calendar = await legacyCiphertext(
      JSON.stringify(calendarCredentials),
      previousKey,
    );
    const integration = await legacyCiphertext(
      JSON.stringify({ apiKey: "legacy-integration-key" }),
      previousKey,
      "integration-legacy-1",
    );
    const webhook = await legacyCiphertext(
      "whsec_legacy-secret",
      previousKey,
      "webhook-legacy-1",
    );

    await expect(
      decryptCalendarCredentials(
        JSON.stringify({
          version: 1,
          iv: base64(calendar.iv),
          ciphertext: base64(calendar.ciphertext),
        }),
        activeKey,
        context,
        previousKey,
      ),
    ).resolves.toEqual(calendarCredentials);
    await expect(
      decryptIntegrationCredentials(
        JSON.stringify({
          version: 1,
          iv: base64(integration.iv),
          ciphertext: base64(integration.ciphertext),
        }),
        activeKey,
        "integration-legacy-1",
        previousKey,
      ),
    ).resolves.toEqual({ apiKey: "legacy-integration-key" });
    await expect(
      decryptWebhookSecret(
        `v1:${base64(webhook.iv, true)}:${base64(webhook.ciphertext, true)}`,
        "webhook-legacy-1",
        activeKey,
        previousKey,
      ),
    ).resolves.toBe("whsec_legacy-secret");
  });

  it("matches key identifiers exactly when selecting rows to rewrap", async () => {
    const activeKeyId = await activeIntegrationCredentialKeyId(activeKey);
    expect(activeKeyId).toContain("_");
    const unavailableKeyId = activeKeyId.replace("_", "X");
    const integrationId = `integration-key-id-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO integration_connections (
         id, organisation_id, provider, status, direction,
         encrypted_credentials
       ) VALUES (?, 'org-future-events', 'test', 'connected', 'outbound', ?)`,
    )
      .bind(
        integrationId,
        JSON.stringify({
          version: 2,
          keyId: unavailableKeyId,
          iv: "AA==",
          ciphertext: "AA==",
        }),
      )
      .run();

    try {
      await expect(
        rewrapProviderCredentials({
          ...(env as unknown as CloudflareEnvironment),
          CALENDAR_CREDENTIALS_KEY: activeKey,
          INTEGRATION_CREDENTIALS_KEY: activeKey,
          WEBHOOK_CREDENTIALS_KEY: activeKey,
        } as CloudflareEnvironment),
      ).rejects.toThrow(`Credential key ${unavailableKeyId} is unavailable.`);
    } finally {
      await env.DB.prepare("DELETE FROM integration_connections WHERE id = ?")
        .bind(integrationId)
        .run();
    }
  });

  it("rewraps explicit previous keys and leaves erased webhook secrets alone", async () => {
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      CALENDAR_CREDENTIALS_KEY: activeKey,
      CALENDAR_CREDENTIALS_PREVIOUS_KEY: previousKey,
      INTEGRATION_CREDENTIALS_KEY: activeKey,
      INTEGRATION_CREDENTIALS_PREVIOUS_KEY: previousKey,
      WEBHOOK_CREDENTIALS_KEY: activeKey,
      WEBHOOK_CREDENTIALS_PREVIOUS_KEY: previousKey,
    } as CloudflareEnvironment;
    const suffix = crypto.randomUUID();
    const calendarId = `calendar-rotation-${suffix}`;
    const integrationId = `integration-rotation-${suffix}`;
    const webhookId = `webhook-rotation-${suffix}`;
    const erasedWebhookId = `webhook-erased-${suffix}`;
    const calendarContext = {
      connectionId: calendarId,
      organisationId: "org-future-events",
      provider: "google" as const,
    };
    const calendarCredentials = {
      accessToken: "calendar-access-token",
      refreshToken: "calendar-refresh-token",
      accessTokenExpiresAt: 2_000_000_000,
      tokenType: "Bearer" as const,
    };
    const integrationCredentials = { apiKey: "integration-secret" };
    const webhookSecret = "whsec_rotation-secret";
    const webhookCiphertext = await encryptWebhookSecret(
      webhookSecret,
      webhookId,
      previousKey,
    );
    const webhookCommandId = `webhook-command-${suffix}`;
    const calendarCiphertext = await encryptCalendarCredentials(
      calendarCredentials,
      previousKey,
      calendarContext,
    );
    const calendarGeneration =
      await calendarCredentialGeneration(calendarCiphertext);
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO calendar_connections (
           id, organisation_id, person_id, provider, account_reference,
           encrypted_credentials, scopes_json, status, expires_at
         ) VALUES (?, 'org-future-events', 'person-demo-admin', 'google', ?, ?,
                   '[]', 'connected', 2000000000)`,
      ).bind(calendarId, calendarId, calendarCiphertext),
      testEnv.DB.prepare(
        `INSERT INTO integration_connections (
           id, organisation_id, provider, status, direction,
           encrypted_credentials
         ) VALUES (?, 'org-future-events', 'test', 'connected', 'outbound', ?)`,
      ).bind(
        integrationId,
        await encryptIntegrationCredentials(
          integrationCredentials,
          previousKey,
          integrationId,
        ),
      ),
      testEnv.DB.prepare(
        `INSERT INTO webhook_endpoints (
           id, organisation_id, event_id, name, url, secret_ciphertext,
           event_types_json, created_by_person_id
         ) VALUES (?, 'org-future-events', 'evt-foe-2025', 'Rotation test',
                   'https://hooks.example.com/rotation', ?, '["program_cue.test"]',
                   'person-demo-admin')`,
      ).bind(webhookId, webhookCiphertext),
      testEnv.DB.prepare(
        `INSERT INTO idempotency_records (
           id, organisation_id, event_id, actor_id, scope, idempotency_key,
           request_hash, status, response_status, response_json, expires_at
         ) VALUES (?, 'org-future-events', 'evt-foe-2025',
                   'person:person-demo-admin',
                   'api.webhook-endpoint.rotate-secret', ?, 'request-hash',
                   'completed', 200, ?, unixepoch() + 604800)`,
      ).bind(
        webhookCommandId,
        webhookCommandId,
        JSON.stringify({
          endpointId: webhookId,
          secretFingerprint: await apiRequestHash(webhookCiphertext),
        }),
      ),
      testEnv.DB.prepare(
        `INSERT INTO webhook_endpoints (
           id, organisation_id, event_id, name, url, secret_ciphertext,
           event_types_json, status, created_by_person_id
         ) VALUES (?, 'org-future-events', 'evt-foe-2025', 'Erased test',
                   'https://hooks.example.com/erased', 'retained-' || ?,
                   '["program_cue.test"]', 'disabled', 'person-demo-admin')`,
      ).bind(erasedWebhookId, erasedWebhookId),
    ]);

    expect(providerCredentialRotationActive(testEnv)).toBe(true);
    await expect(rewrapProviderCredentials(testEnv)).resolves.toMatchObject({
      calendar: 1,
      integrations: 1,
      webhooks: 1,
      remaining: 0,
    });

    const stored = await testEnv.DB.batch([
      testEnv.DB.prepare(
        "SELECT encrypted_credentials AS ciphertext FROM calendar_connections WHERE id = ?",
      ).bind(calendarId),
      testEnv.DB.prepare(
        "SELECT encrypted_credentials AS ciphertext FROM integration_connections WHERE id = ?",
      ).bind(integrationId),
      testEnv.DB.prepare(
        "SELECT secret_ciphertext AS ciphertext FROM webhook_endpoints WHERE id = ?",
      ).bind(webhookId),
      testEnv.DB.prepare(
        "SELECT secret_ciphertext AS ciphertext FROM webhook_endpoints WHERE id = ?",
      ).bind(erasedWebhookId),
      testEnv.DB.prepare(
        "SELECT response_json AS responseJson FROM idempotency_records WHERE id = ?",
      ).bind(webhookCommandId),
    ]);
    const [calendar, integration, webhook, erased, idempotency] = stored.map(
      (result) =>
        result.results[0] as { ciphertext: string; responseJson: string },
    );
    await expect(
      calendarCredentialGeneration(calendar.ciphertext),
    ).resolves.toBe(calendarGeneration);
    await expect(
      decryptCalendarCredentials(
        calendar.ciphertext,
        activeKey,
        calendarContext,
      ),
    ).resolves.toEqual(calendarCredentials);
    await expect(
      decryptIntegrationCredentials(
        integration.ciphertext,
        activeKey,
        integrationId,
      ),
    ).resolves.toEqual(integrationCredentials);
    await expect(
      decryptWebhookSecret(webhook.ciphertext, webhookId, activeKey),
    ).resolves.toBe(webhookSecret);
    expect(erased.ciphertext).toBe(`retained-${erasedWebhookId}`);
    expect(JSON.parse(idempotency.responseJson)).toEqual({
      endpointId: webhookId,
      secretFingerprint: await apiRequestHash(webhookSecret),
      secretFingerprintVersion: 2,
    });
    await expect(rewrapProviderCredentials(testEnv)).resolves.toEqual({
      calendar: 0,
      integrations: 0,
      webhooks: 0,
      remaining: 0,
    });
  });
});
