import { z } from "zod";

const NOTICE_PURPOSE = "programcue:application-notice:v1";
const NOTICE_LIFETIME_SECONDS = 5 * 60;

export const applicationNoticeKindSchema = z.enum([
  "created",
  "saved",
  "submitted",
  "revised",
  "withdrawn",
  "claimed",
  "profile_updated",
  "submission_blocked",
]);

const applicationNoticePayloadSchema = z.object({
  version: z.literal(1),
  slug: z.string().min(1).max(160),
  kind: applicationNoticeKindSchema,
  submissionId: z.string().min(1).max(160).nullable(),
  webhookWarning: z.boolean(),
  expiresAt: z.number().int().positive(),
});

export type ApplicationNotice = z.infer<typeof applicationNoticePayloadSchema>;

export class ApplicationNoticeConfigurationError extends Error {
  constructor() {
    super(
      "BETTER_AUTH_SECRET must be configured with at least 32 characters before application changes can be acknowledged.",
    );
    this.name = "ApplicationNoticeConfigurationError";
  }
}

function requireSecret(env: CloudflareEnvironment) {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new ApplicationNoticeConfigurationError();
  return secret;
}

export function assertApplicationNoticeConfiguration(
  env: CloudflareEnvironment,
) {
  requireSecret(env);
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: KeyUsage[]) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

export async function createApplicationNotice(
  env: CloudflareEnvironment,
  input: Omit<ApplicationNotice, "version" | "expiresAt">,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const payload = applicationNoticePayloadSchema.parse({
    version: 1,
    ...input,
    expiresAt: nowSeconds + NOTICE_LIFETIME_SECONDS,
  });
  const encoded = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(requireSecret(env), ["sign"]),
    new TextEncoder().encode(`${NOTICE_PURPOSE}.${encoded}`),
  );
  return `${encoded}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifyApplicationNotice(
  env: CloudflareEnvironment,
  token: string | null,
  expectedSlug: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<ApplicationNotice | null> {
  if (!token || token.length > 2_048) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const payloadBytes = decodeBase64Url(parts[0]);
  const signature = decodeBase64Url(parts[1]);
  if (!payloadBytes || !signature) return null;
  const verified = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(requireSecret(env), ["verify"]),
    signature,
    new TextEncoder().encode(`${NOTICE_PURPOSE}.${parts[0]}`),
  );
  if (!verified) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  const payload = applicationNoticePayloadSchema.safeParse(decoded);
  if (
    !payload.success ||
    payload.data.slug !== expectedSlug ||
    payload.data.expiresAt <= nowSeconds
  )
    return null;
  return payload.data;
}
