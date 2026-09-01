import {
  credentialKeyCandidates,
  RotatingCredentialKeyConfigurationError,
  rotatingCredentialKeyring,
} from "~/platform/security/rotating-credential-key.server";

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

async function webhookCredentialKeyring(
  encodedKey: string | undefined,
  previousEncodedKey?: string,
) {
  try {
    return await rotatingCredentialKeyring(
      encodedKey,
      previousEncodedKey,
      "WEBHOOK_CREDENTIALS_KEY",
    );
  } catch (error) {
    if (error instanceof RotatingCredentialKeyConfigurationError) {
      throw new WebhookCredentialConfigurationError(error.message);
    }
    throw error;
  }
}

export function createWebhookSecret() {
  return `whsec_${bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export async function encryptWebhookSecret(
  secret: string,
  endpointId: string,
  encodedKey: string | undefined,
) {
  const { active } = await webhookCredentialKeyring(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(endpointId),
    },
    active.key,
    encoder.encode(secret),
  );
  return `v2:${active.id}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptWebhookSecret(
  ciphertext: string,
  endpointId: string,
  encodedKey: string | undefined,
  previousEncodedKey?: string,
) {
  const parts = ciphertext.split(":");
  const version = parts[0];
  const keyId = version === "v2" ? parts[1] : null;
  const encodedIv = version === "v2" ? parts[2] : parts[1];
  const encodedPayload = version === "v2" ? parts[3] : parts[2];
  if (
    !["v1", "v2"].includes(version ?? "") ||
    (version === "v1" && parts.length !== 3) ||
    (version === "v2" &&
      (parts.length !== 4 || !keyId || keyId.length !== 16)) ||
    !encodedIv ||
    !encodedPayload
  ) {
    throw new WebhookCredentialConfigurationError(
      "The stored webhook credential envelope is invalid.",
    );
  }
  const keyring = await webhookCredentialKeyring(
    encodedKey,
    previousEncodedKey,
  );
  let candidates = keyring.candidates;
  try {
    candidates = credentialKeyCandidates(keyring, keyId);
  } catch (error) {
    if (error instanceof RotatingCredentialKeyConfigurationError) {
      throw new WebhookCredentialConfigurationError(error.message);
    }
    throw error;
  }
  for (const candidate of candidates) {
    try {
      const decrypted = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64ToBytes(encodedIv),
          additionalData: encoder.encode(endpointId),
        },
        candidate.key,
        base64ToBytes(encodedPayload),
      );
      return new TextDecoder().decode(decrypted);
    } catch {
      // Version 1 has no key id, so try the explicit previous key only while
      // the rotation window is open.
    }
  }
  throw new WebhookCredentialConfigurationError(
    "The stored webhook secret could not be decrypted with WEBHOOK_CREDENTIALS_KEY.",
  );
}

export async function activeWebhookCredentialKeyId(
  encodedKey: string | undefined,
) {
  return (await webhookCredentialKeyring(encodedKey)).active.id;
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
