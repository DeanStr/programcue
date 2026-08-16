import { data } from "react-router";
import { createCommunicationUnsubscribeUrl } from "~/modules/communications/unsubscribe.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import type { Route } from "./+types/demo-communication-unsubscribe-fixture";

const EVENT_ID = "evt-foe-2025";
const COMMUNICATION_ID = "communication-demo-unsubscribe-browser";
const DELIVERY_ID = "d701829a-d2e1-49f4-9b70-465d86193429";
const ADDRESS = "browser-unsubscribe@example.com";
const CATEGORY = "ad_hoc";
const CONFIRMATION = "manage-communication-unsubscribe-demo-fixture";

function requireDemo(env: CloudflareEnvironment) {
  if (String(env.DEMO_MODE) !== "true") {
    throw new Response("Not found", { status: 404 });
  }
}

function requireConfirmation(request: Request, formData?: FormData) {
  const confirmation =
    formData?.get("confirm") ??
    new URL(request.url).searchParams.get("confirm");
  if (confirmation !== CONFIRMATION) {
    throw new Response("Explicit demo fixture confirmation is required", {
      status: 400,
    });
  }
}

async function fixtureState(env: CloudflareEnvironment) {
  const preference = await env.DB.prepare(`
    SELECT COUNT(*) AS count, MAX(reason) AS reason, MAX(revoked_at) AS revokedAt
      FROM communication_unsubscribes
     WHERE event_id = ? AND address = ? COLLATE NOCASE AND category = ?
  `)
    .bind(EVENT_ID, ADDRESS, CATEGORY)
    .first<{
      count: number;
      reason: string | null;
      revokedAt: number | null;
    }>();
  return {
    address: ADDRESS,
    category: CATEGORY,
    count: preference?.count ?? 0,
    reason: preference?.reason ?? null,
    revokedAt: preference?.revokedAt ?? null,
  };
}

async function clearFixture(env: CloudflareEnvironment) {
  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM communication_unsubscribes
       WHERE event_id = ? AND address = ? COLLATE NOCASE AND category = ?
    `).bind(EVENT_ID, ADDRESS, CATEGORY),
    env.DB.prepare(`
      DELETE FROM communications WHERE id = ? AND event_id = ?
    `).bind(COMMUNICATION_ID, EVENT_ID),
  ]);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  requireDemo(env);
  requireConfirmation(request);
  return data(
    { ok: true, ...(await fixtureState(env)) },
    {
      headers: { "cache-control": "private, no-store" },
    },
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  requireDemo(env);
  const formData = await request.formData();
  requireConfirmation(request, formData);
  const intent = String(formData.get("intent") ?? "");

  if (intent === "clear") {
    await clearFixture(env);
    return data({ ok: true, cleared: true });
  }
  if (intent !== "seed") {
    throw new Response("Unsupported demo fixture action", { status: 400 });
  }

  await ensureDemoData(env);
  await clearFixture(env);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO communications (
        id, event_id, idempotency_key, kind, channel, status, audience_json,
        content_snapshot_json, recipient_count, created_at, updated_at
      ) VALUES (?, ?, ?, 'optional', 'email', 'sent', '{}', ?, 1, unixepoch(), unixepoch())
    `).bind(
      COMMUNICATION_ID,
      EVENT_ID,
      "demo-unsubscribe-browser-fixture",
      JSON.stringify({ schemaVersion: 1, category: CATEGORY }),
    ),
    env.DB.prepare(`
      INSERT INTO communication_deliveries (
        id, event_id, communication_id, person_id, recipient_address, recipient_name,
        channel, provider, idempotency_key, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'person-demo-speaker', ?, 'Browser Recipient',
                'email', 'resend', ?, 'sent', unixepoch(), unixepoch())
    `).bind(
      DELIVERY_ID,
      EVENT_ID,
      COMMUNICATION_ID,
      ADDRESS,
      "demo-unsubscribe-browser-delivery",
    ),
  ]);

  const unsubscribeUrl = new URL(
    await createCommunicationUnsubscribeUrl(env, DELIVERY_ID),
  );
  return data({
    ok: true,
    unsubscribePath: `${unsubscribeUrl.pathname}${unsubscribeUrl.search}`,
    statePath: `/demo/fixtures/communication-unsubscribe?confirm=${encodeURIComponent(CONFIRMATION)}`,
    ...(await fixtureState(env)),
  });
}
