const encoder = new TextEncoder();

export class WebhookCredentialConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookCredentialConfigurationError";
  }
}

function bytesToBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64ToBytes(value: string) {
  try {
    const standard = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(
      standard.padEnd(Math.ceil(standard.length / 4) * 4, "="),
    );
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new WebhookCredentialConfigurationError(
      "WEBHOOK_CREDENTIALS_KEY must be valid base64.",
    );
  }
}

async function credentialKey(encodedKey: string | undefined) {
  if (!encodedKey?.trim()) {
    throw new WebhookCredentialConfigurationError(
      "WEBHOOK_CREDENTIALS_KEY is required for outbound webhooks.",
    );
  }
  const bytes = base64ToBytes(encodedKey.trim());
  if (bytes.byteLength !== 32) {
    throw new WebhookCredentialConfigurationError(
      "WEBHOOK_CREDENTIALS_KEY must decode to exactly 32 bytes.",
    );
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export function createWebhookSecret() {
  return `whsec_${bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export async function encryptWebhookSecret(
  secret: string,
  endpointId: string,
  encodedKey: string | undefined,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(endpointId),
    },
    await credentialKey(encodedKey),
    encoder.encode(secret),
  );
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptWebhookSecret(
  ciphertext: string,
  endpointId: string,
  encodedKey: string | undefined,
) {
  const [version, encodedIv, encodedPayload, extra] = ciphertext.split(":");
  if (version !== "v1" || !encodedIv || !encodedPayload || extra) {
    throw new WebhookCredentialConfigurationError(
      "The stored webhook credential envelope is invalid.",
    );
  }
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(encodedIv),
        additionalData: encoder.encode(endpointId),
      },
      await credentialKey(encodedKey),
      base64ToBytes(encodedPayload),
    );
    return new TextDecoder().decode(decrypted);
  } catch (error) {
    if (error instanceof WebhookCredentialConfigurationError) throw error;
    throw new WebhookCredentialConfigurationError(
      "The stored webhook secret could not be decrypted with WEBHOOK_CREDENTIALS_KEY.",
    );
  }
}

export async function signWebhookPayload(
  secret: string,
  timestamp: number,
  payload: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${payload}`),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
