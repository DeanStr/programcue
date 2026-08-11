import { env as testEnv } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { action } from "./api-resend-webhook";

function context(environment = {} as CloudflareEnvironment) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return context;
}

async function signedWebhook(
  body: string,
  secret: string,
  contentType = "application/json",
) {
  const webhookId = `webhook-${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const keyBytes = Uint8Array.from(
    atob(secret.slice("whsec_".length)),
    (character) => character.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${webhookId}.${timestamp}.${body}`),
    ),
  );
  const encodedSignature = btoa(String.fromCharCode(...signature));
  return new Request("https://programcue.test/api/webhooks/resend", {
    method: "POST",
    headers: {
      "content-type": contentType,
      "svix-id": webhookId,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${encodedSignature}`,
    },
    body,
  });
}

describe("Resend webhook route methods", () => {
  it("rejects a non-POST request before webhook processing", async () => {
    const response = await action({
      request: new Request("https://programcue.test/api/webhooks/resend", {
        method: "PUT",
      }),
      params: {},
      context: context(),
    } as never);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    await expect(response.text()).resolves.toBe("Method not allowed");
  });

  it("enforces the payload limit in UTF-8 bytes when content-length is unavailable", async () => {
    const response = await action({
      request: new Request("https://programcue.test/api/webhooks/resend", {
        method: "POST",
        body: "é".repeat(128_001),
      }),
      params: {},
      context: context(),
    } as never);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Webhook payload exceeds 256 KB.",
    });
  });

  it("cancels a multi-chunk body as soon as it crosses the payload limit", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(100_000));
        if (pulls === 4) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://programcue.test/api/webhooks/resend", {
      method: "POST",
      body,
    });
    const response = await action({
      request,
      params: {},
      context: context(),
    } as never);

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("separates configuration failure from untrusted signature failure without leaking configuration", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const unconfigured = await action({
      request: new Request("https://programcue.test/api/webhooks/resend", {
        method: "POST",
        body: "{}",
      }),
      params: {},
      context: context(),
    } as never);
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.headers.get("retry-after")).toBe("30");
    await expect(unconfigured.json()).resolves.toEqual({
      error: "Resend webhook configuration is unavailable.",
    });
    const logEntry = String(logged.mock.calls[0]?.[0]);
    expect(JSON.parse(logEntry)).toMatchObject({
      subsystem: "resend-webhook",
      event: "configuration-unavailable",
      errorName: "WebhookConfigurationError",
    });
    expect(logEntry).not.toContain("RESEND_WEBHOOK_SECRET");

    const secret = `whsec_${btoa("program-cue-webhook-test-secret")}`;
    const unauthenticated = await action({
      request: new Request("https://programcue.test/api/webhooks/resend", {
        method: "POST",
        body: "{}",
      }),
      params: {},
      context: context({
        ...(testEnv as unknown as CloudflareEnvironment),
        RESEND_WEBHOOK_SECRET: secret,
      } as CloudflareEnvironment),
    } as never);
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toEqual({
      error: "Webhook authentication failed.",
    });
    logged.mockRestore();
  });

  it("rejects a signed non-JSON media type before parsing", async () => {
    const secret = `whsec_${btoa("program-cue-webhook-test-secret")}`;
    const response = await action({
      request: await signedWebhook("not-json", secret, "text/plain"),
      params: {},
      context: context({
        ...(testEnv as unknown as CloudflareEnvironment),
        RESEND_WEBHOOK_SECRET: secret,
      } as CloudflareEnvironment),
    } as never);
    expect(response.status).toBe(415);
  });

  it("asks Resend to retry a verified event until its delivery can be reconciled", async () => {
    const secret = `whsec_${btoa("program-cue-webhook-test-secret")}`;
    const body = JSON.stringify({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: { email_id: `not-yet-persisted-${crypto.randomUUID()}` },
    });
    const response = await action({
      request: await signedWebhook(body, secret),
      params: {},
      context: context({
        ...(testEnv as unknown as CloudflareEnvironment),
        RESEND_WEBHOOK_SECRET: secret,
      } as CloudflareEnvironment),
    } as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.json()).resolves.toEqual({
      error:
        "The delivery is not available for reconciliation yet; retry this webhook.",
    });
  });
});
