import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyResendWebhook } from "./resend-webhook.server";

afterEach(() => vi.restoreAllMocks());

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
