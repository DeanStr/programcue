import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { createCommunicationUnsubscribeUrl } from "~/modules/communications/unsubscribe.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action, loader } from "./communication-unsubscribe";

async function unsubscribeFixture() {
  const testEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  const communicationId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const address = `route-optout-${deliveryId.slice(0, 8)}@example.com`;
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO communications (
        id, event_id, idempotency_key, kind, channel, status, audience_json,
        content_snapshot_json, recipient_count, created_at, updated_at
      ) VALUES (?, 'evt-foe-2025', ?, 'optional', 'email', 'sent', '{}',
                '{"schemaVersion":1,"category":"ad_hoc"}', 1, unixepoch(), unixepoch())
    `).bind(communicationId, `unsubscribe-route-${communicationId}`),
    env.DB.prepare(`
      INSERT INTO communication_deliveries (
        id, event_id, communication_id, person_id, recipient_address, recipient_name,
        channel, provider, idempotency_key, status, created_at, updated_at
      ) VALUES (?, 'evt-foe-2025', ?, 'person-demo-speaker', ?,
                'Route Recipient', 'email', 'resend', ?, 'sent', unixepoch(), unixepoch())
    `).bind(
      deliveryId,
      communicationId,
      address,
      `unsubscribe-delivery-${deliveryId}`,
    ),
  ]);
  const unsubscribeUrl = await createCommunicationUnsubscribeUrl(
    testEnv,
    deliveryId,
  );
  const token = decodeURIComponent(
    new URL(unsubscribeUrl).pathname.split("/").at(-1)!,
  );
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env: testEnv, ctx: {} as ExecutionContext });
  return { testEnv, token, context, unsubscribeUrl, deliveryId, address };
}

function args(request: Request, token: string, context: RouterContextProvider) {
  return { request, params: { token }, context } as never;
}

describe("public communication unsubscribe route", () => {
  it("keeps GET read-only and requires a confirmation POST before recording the category opt-out", async () => {
    const { token, context, unsubscribeUrl, address } =
      await unsubscribeFixture();
    await loader(args(new Request(unsubscribeUrl), token, context));
    expect(
      await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM communication_unsubscribes
       WHERE event_id = 'evt-foe-2025' AND address = ?
    `)
        .bind(address)
        .first(),
    ).toEqual({ count: 0 });

    const methodRejected = await action(
      args(new Request(unsubscribeUrl, { method: "PUT" }), token, context),
    );
    expect(methodRejected.status).toBe(405);
    expect(methodRejected.headers.get("allow")).toBe("POST");

    const applied = await action(
      args(
        new Request(`${unsubscribeUrl}.data`, { method: "POST" }),
        token,
        context,
      ),
    );
    expect(applied.status).toBe(303);
    expect(applied.headers.get("location")).toBe(
      new URL(unsubscribeUrl).pathname,
    );
    expect(
      await env.DB.prepare(`
      SELECT address, category, reason, revoked_at AS revokedAt
        FROM communication_unsubscribes
       WHERE event_id = 'evt-foe-2025' AND address = ?
    `)
        .bind(address)
        .first(),
    ).toEqual({
      address,
      category: "ad_hoc",
      reason: "recipient_unsubscribe",
      revokedAt: null,
    });
    const confirmed = await loader(
      args(new Request(unsubscribeUrl), token, context),
    );
    expect(confirmed.data).toMatchObject({ isUnsubscribed: true });

    await action(
      args(new Request(unsubscribeUrl, { method: "POST" }), token, context),
    );
    expect(
      await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM communication_unsubscribes
       WHERE event_id = 'evt-foe-2025' AND address = ? AND category = 'ad_hoc'
    `)
        .bind(address)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("rejects tampered and expired signed tokens without changing preferences", async () => {
    const { testEnv, token, context, unsubscribeUrl, deliveryId, address } =
      await unsubscribeFixture();
    const [payload, signature] = token.split(".");
    const tamperedToken = `${payload}.${signature?.startsWith("A") ? "B" : "A"}${signature?.slice(1)}`;
    await expect(
      loader(
        args(
          new Request(
            unsubscribeUrl.replace(
              encodeURIComponent(token),
              encodeURIComponent(tamperedToken),
            ),
          ),
          tamperedToken,
          context,
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });

    const expiredUrl = await createCommunicationUnsubscribeUrl(
      testEnv,
      deliveryId,
      1,
    );
    const expiredToken = decodeURIComponent(
      new URL(expiredUrl).pathname.split("/").at(-1)!,
    );
    await expect(
      loader(args(new Request(expiredUrl), expiredToken, context)),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM communication_unsubscribes
       WHERE event_id = 'evt-foe-2025' AND address = ?
    `)
        .bind(address)
        .first(),
    ).toEqual({ count: 0 });
  });
});
