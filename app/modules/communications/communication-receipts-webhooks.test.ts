import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  handleProgramCueQueueMessage,
  processCommunicationSend,
  processDecisionNotification,
  processSubmissionNotification,
  QUEUE_CLAIM_LEASE_SECONDS,
} from "../../../workers/communications-queue";
import {
  CommunicationQueueUnavailableError,
  CommunicationService,
} from "./communication-service.server";
import { snapshotSourceValues } from "./communication-service-shared";
import { CommunicationDeliveryService } from "./communication-delivery-service.server";
import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { CommunicationTemplateService } from "./communication-template-service.server";
import { MailpitEmailProvider } from "./mailpit.server";
import { RecipientQuery } from "./recipient-query.server";
import { ResendEmailProvider } from "./resend.server";
import {
  createCommunicationUnsubscribeUrl,
  describeCommunicationUnsubscribe,
  unsubscribeFromOptionalCommunication,
} from "./unsubscribe.server";
import { verifyResendWebhook } from "./resend-webhook.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

afterEach(() => vi.restoreAllMocks());

async function communicationEnvironment() {
  const sent: unknown[] = [];
  const realtime: unknown[] = [];
  const eventChannel = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(_input: RequestInfo | URL, init?: RequestInit) {
          realtime.push(JSON.parse(String(init?.body)));
          return Response.json({ accepted: true });
        },
      };
    },
  };
  const testEnv = {
    ...(env as unknown as CloudflareEnvironment),
    SOURCE_REVISION: "test-revision",
    DB: env.DB,
    RESEND_API_KEY: "test-resend-key",
    OPERATIONS_QUEUE: {
      send: async (message: unknown) => {
        sent.push(message);
      },
    },
    EVENT_CHANNEL: eventChannel,
  } as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  await env.DB.prepare(
    "DELETE FROM webhook_endpoints WHERE event_id = ? AND name = 'Communication completion receiver'",
  )
    .bind(viewer.eventId)
    .run();
  await env.DB.prepare(
    `
    INSERT OR IGNORE INTO sender_profiles (
      id, event_id, name, from_name, from_email, reply_to_email, provider, status, created_at, updated_at
    ) VALUES ('sender-test-communications', ?, 'Test communications', 'Program Cue', 'events@example.com',
              'reply@example.com', 'resend', 'verified', unixepoch(), unixepoch())
  `,
  )
    .bind(viewer.eventId)
    .run();
  await env.DB.prepare(
    `UPDATE sender_profiles
        SET provider = 'resend', status = 'verified'
      WHERE id = 'sender-test-communications' AND event_id = ?`,
  )
    .bind(viewer.eventId)
    .run();
  return { testEnv, sent, realtime };
}

async function confirmPreviewed(
  service: CommunicationService,
  input: Parameters<CommunicationService["preview"]>[1] & {
    idempotencyKey: string;
  },
) {
  const preview = await service.preview(viewer, input);
  return service.confirm(viewer, {
    ...input,
    ...preview.confirmation,
  });
}

describe("Communications D1 vertical slice", () => {
  describe("receipt and webhook workflows", () => {
    it("verifies the signed webhook body and rejects replayed timestamps", async () => {
      const secretBytes = crypto.getRandomValues(new Uint8Array(32));
      let binary = "";
      for (const byte of secretBytes) binary += String.fromCharCode(byte);
      const secret = `whsec_${btoa(binary)}`;
      const body = JSON.stringify({
        type: "email.sent",
        data: { email_id: "email-id" },
      });
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const webhookId = "msg_webhook_test";
      const key = await crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signed = new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`${webhookId}.${timestamp}.${body}`),
        ),
      );
      let signatureBinary = "";
      for (const byte of signed) signatureBinary += String.fromCharCode(byte);
      await expect(
        verifyResendWebhook({
          body,
          webhookId,
          timestamp,
          signature: `v1,${btoa(signatureBinary)}`,
          secret,
        }),
      ).resolves.toBeUndefined();
      await expect(
        verifyResendWebhook({
          body,
          webhookId,
          timestamp,
          signature: `v1,%%% v1,${btoa(signatureBinary)}`,
          secret,
        }),
      ).resolves.toBeUndefined();
      await expect(
        verifyResendWebhook({
          body,
          webhookId,
          timestamp: String(Number(timestamp) - 1_000),
          signature: `v1,${btoa(signatureBinary)}`,
          secret,
        }),
      ).rejects.toThrow("replay window");
    });
  });
});
