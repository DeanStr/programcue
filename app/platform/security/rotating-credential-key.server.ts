export type RotatingCredentialKey = {
  id: string;
  key: CryptoKey;
};

export type RotatingCredentialKeyring = {
  active: RotatingCredentialKey;
  candidates: RotatingCredentialKey[];
};

export class RotatingCredentialKeyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RotatingCredentialKeyConfigurationError";
  }
}

export function credentialBytesFromBase64(
  value: string | undefined,
  name: string,
) {
  if (!value?.trim()) {
    throw new RotatingCredentialKeyConfigurationError(`${name} is required.`);
  }
  let decoded: string;
  try {
    decoded = atob(value.trim());
  } catch {
    throw new RotatingCredentialKeyConfigurationError(
      `${name} must contain valid base64.`,
    );
  }
  const bytes = Uint8Array.from(decoded, (character) =>
    character.charCodeAt(0),
  );
  if (bytes.byteLength !== 32) {
    throw new RotatingCredentialKeyConfigurationError(
      `${name} must be a base64-encoded 32-byte key.`,
    );
  }
  return bytes;
}

function bytesBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function importCredentialKey(
  value: string | undefined,
  name: string,
): Promise<RotatingCredentialKey> {
  const bytes = credentialBytesFromBase64(value, name);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const id = bytesBase64Url(new Uint8Array(digest).slice(0, 12));
  const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return { id, key };
}

export async function rotatingCredentialKeyring(
  activeValue: string | undefined,
  previousValue: string | undefined,
  activeName: string,
): Promise<RotatingCredentialKeyring> {
  const active = await importCredentialKey(activeValue, activeName);
  if (!previousValue?.trim()) return { active, candidates: [active] };
  const previousName = activeName.replace(/_KEY$/u, "_PREVIOUS_KEY");
  const previous = await importCredentialKey(previousValue, previousName);
  if (previous.id === active.id) {
    throw new RotatingCredentialKeyConfigurationError(
      `${activeName} and ${previousName} must be independently generated.`,
    );
  }
  return { active, candidates: [active, previous] };
}

export function credentialKeyCandidates(
  keyring: RotatingCredentialKeyring,
  keyId: string | null,
) {
  if (keyId === null) return keyring.candidates;
  const selected = keyring.candidates.find(
    (candidate) => candidate.id === keyId,
  );
  if (!selected) {
    throw new RotatingCredentialKeyConfigurationError(
      `Credential key ${keyId} is unavailable.`,
    );
  }
  return [selected];
}
