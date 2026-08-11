import { z } from "zod";

const encryptedEnvelopeSchema = z.object({
  version: z.literal(1),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
});

export class IntegrationCredentialConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationCredentialConfigurationError";
  }
}

function bytesFromBase64(value: string) {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new IntegrationCredentialConfigurationError(
      "INTEGRATION_CREDENTIALS_KEY must contain valid base64.",
    );
  }
}

function bytesToBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function importCredentialKey(base64Key: string | undefined) {
  if (!base64Key?.trim()) {
    throw new IntegrationCredentialConfigurationError(
      "INTEGRATION_CREDENTIALS_KEY is required for external integrations.",
    );
  }
  const bytes = bytesFromBase64(base64Key);
  if (bytes.byteLength !== 32) {
    throw new IntegrationCredentialConfigurationError(
      "INTEGRATION_CREDENTIALS_KEY must be a base64-encoded 32-byte key.",
    );
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptIntegrationCredentials(
  credentials: unknown,
  base64Key: string | undefined,
  connectionId: string,
) {
  const key = await importCredentialKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(connectionId),
    },
    key,
    new TextEncoder().encode(JSON.stringify(credentials)),
  );
  return JSON.stringify({
    version: 1,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptIntegrationCredentials(
  encrypted: string,
  base64Key: string | undefined,
  connectionId: string,
) {
  let envelope: z.infer<typeof encryptedEnvelopeSchema>;
  try {
    envelope = encryptedEnvelopeSchema.parse(JSON.parse(encrypted));
  } catch {
    throw new IntegrationCredentialConfigurationError(
      "Integration credentials use an invalid encrypted envelope.",
    );
  }
  try {
    const key = await importCredentialKey(base64Key);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytesFromBase64(envelope.iv),
        additionalData: new TextEncoder().encode(connectionId),
      },
      key,
      bytesFromBase64(envelope.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  } catch (error) {
    if (error instanceof IntegrationCredentialConfigurationError) throw error;
    throw new IntegrationCredentialConfigurationError(
      "Integration credentials could not be decrypted.",
    );
  }
}
