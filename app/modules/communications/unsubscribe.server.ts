import { z } from "zod";

import { communicationCategorySchema, type CommunicationCategory } from "./communication-schema";

const tokenLifetimeSeconds = 365 * 24 * 60 * 60;
const tokenPurpose = "programcue:communication-unsubscribe:v1";
const tokenPayloadSchema = z.object({
  version: z.literal(1),
  deliveryId: z.uuid(),
  expiresAt: z.number().int().positive(),
});

type UnsubscribePreference = {
  deliveryId: string;
  eventId: string;
  eventName: string;
  personId: string | null;
  address: string;
  category: CommunicationCategory;
  isUnsubscribed: boolean;
};

export class UnsubscribeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsubscribeConfigurationError";
  }
}

export class InvalidUnsubscribeTokenError extends Error {
  constructor() {
    super("This unsubscribe link is invalid or has expired.");
    this.name = "InvalidUnsubscribeTokenError";
  }
}

function requireSigningSecret(env: CloudflareEnvironment) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new UnsubscribeConfigurationError(
      "BETTER_AUTH_SECRET must be configured with at least 32 characters before optional email can be sent.",
    );
  }
  return env.BETTER_AUTH_SECRET;
}

function applicationOrigin(env: CloudflareEnvironment) {
  if (!env.BETTER_AUTH_URL) {
    throw new UnsubscribeConfigurationError(
      "BETTER_AUTH_URL must be configured before optional email can be sent.",
    );
  }
  let configured: URL;
  try {
    configured = new URL(env.BETTER_AUTH_URL);
  } catch {
    throw new UnsubscribeConfigurationError("BETTER_AUTH_URL must be an absolute HTTP(S) URL.");
  }
  if (!(["http:", "https:"] as string[]).includes(configured.protocol)) {
    throw new UnsubscribeConfigurationError("BETTER_AUTH_URL must be an absolute HTTP(S) URL.");
  }
  if (env.APP_ENV === "production" && configured.protocol !== "https:") {
    throw new UnsubscribeConfigurationError("BETTER_AUTH_URL must use HTTPS in production.");
  }
  return configured.origin;
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidUnsubscribeTokenError();
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new InvalidUnsubscribeTokenError();
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signingKey(secret: string, usage: KeyUsage[]) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

async function signPayload(env: CloudflareEnvironment, encodedPayload: string) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(requireSigningSecret(env), ["sign"]),
    new TextEncoder().encode(`${tokenPurpose}.${encodedPayload}`),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function parseAndVerifyToken(
  env: CloudflareEnvironment,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new InvalidUnsubscribeTokenError();
  const [encodedPayload, encodedSignature] = parts;
  const signature = decodeBase64Url(encodedSignature);
  const verified = await crypto.subtle.verify(
    "HMAC",
    await signingKey(requireSigningSecret(env), ["verify"]),
    signature,
    new TextEncoder().encode(`${tokenPurpose}.${encodedPayload}`),
  );
  if (!verified) throw new InvalidUnsubscribeTokenError();

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload)));
  } catch {
    throw new InvalidUnsubscribeTokenError();
  }
  const payload = tokenPayloadSchema.safeParse(decoded);
  if (!payload.success || payload.data.expiresAt <= nowSeconds) {
    throw new InvalidUnsubscribeTokenError();
  }
  return payload.data;
}

async function preferenceForToken(env: CloudflareEnvironment, token: string) {
  const payload = await parseAndVerifyToken(env, token);
  const row = await env.DB.prepare(`
    SELECT d.id AS deliveryId, d.event_id AS eventId, e.name AS eventName,
           d.person_id AS personId, lower(d.recipient_address) AS address,
           json_extract(c.content_snapshot_json, '$.category') AS category,
           EXISTS (
             SELECT 1 FROM communication_unsubscribes u
              WHERE u.event_id = d.event_id AND lower(u.address) = lower(d.recipient_address)
                AND u.revoked_at IS NULL
                AND u.category IN (json_extract(c.content_snapshot_json, '$.category'), '*')
           ) AS isUnsubscribed
      FROM communication_deliveries d
      JOIN communications c ON c.id = d.communication_id AND c.event_id = d.event_id
      JOIN events e ON e.id = d.event_id
     WHERE d.id = ? AND d.channel = 'email' AND c.channel = 'email' AND c.kind = 'optional'
  `).bind(payload.deliveryId).first<
    Omit<UnsubscribePreference, "category" | "isUnsubscribed"> & { category: string; isUnsubscribed: number }
  >();
  if (!row) throw new InvalidUnsubscribeTokenError();
  const category = communicationCategorySchema.safeParse(row.category);
  if (!category.success) throw new InvalidUnsubscribeTokenError();
  return { ...row, category: category.data, isUnsubscribed: row.isUnsubscribed === 1 } satisfies UnsubscribePreference;
}

export async function createCommunicationUnsubscribeUrl(
  env: CloudflareEnvironment,
  deliveryId: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const payload = tokenPayloadSchema.parse({
    version: 1,
    deliveryId,
    expiresAt: nowSeconds + tokenLifetimeSeconds,
  });
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const token = `${encodedPayload}.${await signPayload(env, encodedPayload)}`;
  return new URL(`/communications/unsubscribe/${encodeURIComponent(token)}`, applicationOrigin(env)).toString();
}

export async function describeCommunicationUnsubscribe(
  env: CloudflareEnvironment,
  token: string,
) {
  return preferenceForToken(env, token);
}

export async function unsubscribeFromOptionalCommunication(
  env: CloudflareEnvironment,
  token: string,
) {
  const preference = await preferenceForToken(env, token);
  const result = await env.DB.prepare(`
    INSERT INTO communication_unsubscribes (
      id, event_id, person_id, address, category, reason, created_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, 'recipient_unsubscribe', unixepoch(), NULL)
    ON CONFLICT(event_id, address, category) DO UPDATE SET
      person_id = COALESCE(excluded.person_id, communication_unsubscribes.person_id),
      reason = 'recipient_unsubscribe', revoked_at = NULL
    WHERE communication_unsubscribes.revoked_at IS NOT NULL
  `).bind(
    crypto.randomUUID(),
    preference.eventId,
    preference.personId,
    preference.address,
    preference.category,
  ).run();
  return { ...preference, isUnsubscribed: true, changed: (result.meta.changes ?? 0) === 1 };
}
