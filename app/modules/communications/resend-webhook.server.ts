export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

function base64Bytes(value: string) {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new WebhookVerificationError("The webhook secret or signature is not valid base64.");
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let different = 0;
  for (let index = 0; index < left.byteLength; index += 1) different |= left[index] ^ right[index];
  return different === 0;
}

export async function verifyResendWebhook({
  body,
  webhookId,
  timestamp,
  signature,
  secret,
  now = Date.now(),
}: {
  body: string;
  webhookId: string | null;
  timestamp: string | null;
  signature: string | null;
  secret: string | undefined;
  now?: number;
}) {
  if (!secret?.startsWith("whsec_")) throw new WebhookVerificationError("RESEND_WEBHOOK_SECRET is not configured with a whsec_ signing secret.");
  if (!webhookId || !timestamp || !signature) throw new WebhookVerificationError("Required Svix signature headers are missing.");
  const epoch = Number(timestamp);
  if (!Number.isInteger(epoch) || Math.abs(Math.floor(now / 1_000) - epoch) > 300) {
    throw new WebhookVerificationError("The webhook timestamp is outside the five-minute replay window.");
  }
  const key = await crypto.subtle.importKey("raw", base64Bytes(secret.slice("whsec_".length)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${webhookId}.${timestamp}.${body}`)));
  const candidates = signature.split(/\s+/).map((part) => part.split(",", 2)).filter(([version, value]) => version === "v1" && value);
  const verified = candidates.some(([, value]) => {
    try {
      return constantTimeEqual(digest, base64Bytes(value));
    } catch (error) {
      if (error instanceof WebhookVerificationError) return false;
      throw error;
    }
  });
  if (!verified) {
    throw new WebhookVerificationError("The webhook signature is invalid.");
  }
}
