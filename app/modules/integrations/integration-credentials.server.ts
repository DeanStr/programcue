import { z } from "zod";

import {
  credentialKeyCandidates,
  RotatingCredentialKeyConfigurationError,
  rotatingCredentialKeyring,
} from "~/platform/security/rotating-credential-key.server";

const encryptedEnvelopeSchema = z.discriminatedUnion("version", [
  z.object({
    version: z.literal(1),
    iv: z.string().min(1),
    ciphertext: z.string().min(1),
  }),
  z.object({
    version: z.literal(2),
    keyId: z.string().min(16).max(16),
    iv: z.string().min(1),
    ciphertext: z.string().min(1),
  }),
]);

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

async function integrationCredentialKeyring(
  base64Key: string | undefined,
  previousBase64Key?: string,
) {
  try {
    return await rotatingCredentialKeyring(
      base64Key,
      previousBase64Key,
      "INTEGRATION_CREDENTIALS_KEY",
    );
  } catch (error) {
    if (error instanceof RotatingCredentialKeyConfigurationError) {
      throw new IntegrationCredentialConfigurationError(error.message);
    }
    throw error;
  }
}

export async function encryptIntegrationCredentials(
  credentials: unknown,
  base64Key: string | undefined,
  connectionId: string,
) {
  const { active } = await integrationCredentialKeyring(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(connectionId),
    },
    active.key,
    new TextEncoder().encode(JSON.stringify(credentials)),
  );
  return JSON.stringify({
    version: 2,
    keyId: active.id,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptIntegrationCredentials(
  encrypted: string,
  base64Key: string | undefined,
  connectionId: string,
  previousBase64Key?: string,
) {
  let envelope: z.infer<typeof encryptedEnvelopeSchema>;
  try {
    envelope = encryptedEnvelopeSchema.parse(JSON.parse(encrypted));
  } catch {
    throw new IntegrationCredentialConfigurationError(
      "Integration credentials use an invalid encrypted envelope.",
    );
  }
  const keyring = await integrationCredentialKeyring(
    base64Key,
    previousBase64Key,
  );
  let candidates = keyring.candidates;
  try {
    candidates = credentialKeyCandidates(
      keyring,
      envelope.version === 2 ? envelope.keyId : null,
    );
  } catch (error) {
    if (error instanceof RotatingCredentialKeyConfigurationError) {
      throw new IntegrationCredentialConfigurationError(error.message);
    }
    throw error;
  }
  for (const candidate of candidates) {
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytesFromBase64(envelope.iv),
          additionalData: new TextEncoder().encode(connectionId),
        },
        candidate.key,
        bytesFromBase64(envelope.ciphertext),
      );
      return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    } catch {
      // A version-1 envelope has no key id, so an explicit previous key is
      // tried only during the bounded rotation window.
    }
  }
  throw new IntegrationCredentialConfigurationError(
    "Integration credentials could not be decrypted.",
  );
}

export async function activeIntegrationCredentialKeyId(
  base64Key: string | undefined,
) {
  return (await integrationCredentialKeyring(base64Key)).active.id;
}
