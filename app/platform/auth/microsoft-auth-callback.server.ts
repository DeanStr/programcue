import type { BetterAuthPlugin } from "better-auth";

export const MICROSOFT_AUTH_CALLBACK_PATH = "/api/auth/callback/microsoft";

const CALLBACK_RELAY_IDENTIFIER_PREFIX = "microsoft-auth-callback-relay:";
const CALLBACK_RELAY_LIFETIME_SECONDS = 90;
const CALLBACK_RELAY_ID_PATTERN = /^[A-Za-z0-9_-]{32,64}$/u;
const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{20,256}$/u;
const OAUTH_CODE_PATTERN = /^[\x21-\x7E]{20,4096}$/u;
const OAUTH_ERROR_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const MAXIMUM_CALLBACK_BODY_BYTES = 8192;
const MAXIMUM_ERROR_DESCRIPTION_LENGTH = 1024;
const RELAY_ENCRYPTION_CONTEXT = "program-cue:microsoft-auth-callback-relay:v1";

type MicrosoftCallbackPayload = {
  version: 1;
  relayId: string;
  state: string;
  code?: string;
  error?: string;
  errorDescription?: string;
  expiresAt: number;
};

type EncryptedRelayValue = {
  version: 1;
  initializationVector: string;
  ciphertext: string;
};

export class MicrosoftCallbackRelayConfigurationError extends Error {
  constructor() {
    super("Microsoft callback relay encryption is unavailable.");
    this.name = "MicrosoftCallbackRelayConfigurationError";
  }
}

export class MicrosoftCallbackRelayError extends Error {
  constructor() {
    super("The Microsoft sign-in response is invalid or expired.");
    this.name = "MicrosoftCallbackRelayError";
  }
}

export const microsoftFormPostPlugin: BetterAuthPlugin = {
  id: "program-cue-microsoft-form-post",
  init(context) {
    const provider = context.socialProviders.find(
      (candidate) => candidate.id === "microsoft",
    );
    if (!provider) return;
    const createAuthorizationURL =
      provider.createAuthorizationURL.bind(provider);
    provider.createAuthorizationURL = async (data) => {
      const authorizationURL = await createAuthorizationURL(data);
      authorizationURL.searchParams.set("response_mode", "form_post");
      return authorizationURL;
    };
  },
};

function isExactMicrosoftCallback(request: Request) {
  const url = new URL(request.url);
  return url.pathname === MICROSOFT_AUTH_CALLBACK_PATH;
}

function requireRelaySecret(environment: CloudflareEnvironment) {
  const secret = environment.BETTER_AUTH_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new MicrosoftCallbackRelayConfigurationError();
  }
  return secret;
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
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new MicrosoftCallbackRelayError();
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") + padding,
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function relayEncryptionKey(secret: string) {
  const keyMaterial = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${RELAY_ENCRYPTION_CONTEXT}:${secret}`),
  );
  return crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptRelayPayload(
  secret: string,
  payload: MicrosoftCallbackPayload,
) {
  const initializationVector = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: initializationVector,
      additionalData: new TextEncoder().encode(
        `${RELAY_ENCRYPTION_CONTEXT}:${payload.relayId}`,
      ),
    },
    await relayEncryptionKey(secret),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return JSON.stringify({
    version: 1,
    initializationVector: encodeBase64Url(initializationVector),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  } satisfies EncryptedRelayValue);
}

async function decryptRelayPayload(
  secret: string,
  relayId: string,
  storedValue: string,
) {
  let encrypted: EncryptedRelayValue;
  try {
    encrypted = JSON.parse(storedValue) as EncryptedRelayValue;
  } catch {
    throw new MicrosoftCallbackRelayError();
  }
  if (
    encrypted.version !== 1 ||
    typeof encrypted.initializationVector !== "string" ||
    typeof encrypted.ciphertext !== "string"
  ) {
    throw new MicrosoftCallbackRelayError();
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64Url(encrypted.initializationVector),
        additionalData: new TextEncoder().encode(
          `${RELAY_ENCRYPTION_CONTEXT}:${relayId}`,
        ),
      },
      await relayEncryptionKey(secret),
      decodeBase64Url(encrypted.ciphertext),
    );
    return JSON.parse(
      new TextDecoder().decode(plaintext),
    ) as MicrosoftCallbackPayload;
  } catch (error) {
    if (error instanceof MicrosoftCallbackRelayError) throw error;
    throw new MicrosoftCallbackRelayError();
  }
}

function randomRelayId() {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function boundedCallbackPayload(body: URLSearchParams, relayId: string) {
  const hasDuplicateSecurityParameter = [
    "state",
    "code",
    "error",
    "error_description",
  ].some((name) => body.getAll(name).length > 1);
  const state = body.get("state") ?? "";
  const code = body.get("code") ?? "";
  const error = body.get("error") ?? "";
  const errorDescription = body.get("error_description") ?? "";
  if (
    hasDuplicateSecurityParameter ||
    !OAUTH_STATE_PATTERN.test(state) ||
    code.length > 0 === error.length > 0 ||
    (code.length > 0 && !OAUTH_CODE_PATTERN.test(code)) ||
    (error.length > 0 && !OAUTH_ERROR_PATTERN.test(error)) ||
    errorDescription.length > MAXIMUM_ERROR_DESCRIPTION_LENGTH ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: OAuth relay text explicitly rejects ASCII control characters.
    /[\u0000-\u001F\u007F]/u.test(errorDescription)
  ) {
    throw new MicrosoftCallbackRelayError();
  }
  return {
    version: 1,
    relayId,
    state,
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
    ...(errorDescription ? { errorDescription } : {}),
    expiresAt: Date.now() + CALLBACK_RELAY_LIFETIME_SECONDS * 1000,
  } satisfies MicrosoftCallbackPayload;
}

function assertValidStoredPayload(
  payload: MicrosoftCallbackPayload,
  relayId: string,
) {
  if (
    payload.version !== 1 ||
    payload.relayId !== relayId ||
    payload.expiresAt <= Date.now() ||
    !OAUTH_STATE_PATTERN.test(payload.state) ||
    (payload.code !== undefined) === (payload.error !== undefined) ||
    (payload.code !== undefined && !OAUTH_CODE_PATTERN.test(payload.code)) ||
    (payload.error !== undefined && !OAUTH_ERROR_PATTERN.test(payload.error)) ||
    (payload.errorDescription?.length ?? 0) > MAXIMUM_ERROR_DESCRIPTION_LENGTH
  ) {
    throw new MicrosoftCallbackRelayError();
  }
}

async function assertUnexpiredOAuthState(
  environment: CloudflareEnvironment,
  state: string,
) {
  const stored = await environment.DB.prepare(
    `
      SELECT value
        FROM verification_tokens
       WHERE identifier = ?
         AND expires_at > unixepoch()
       ORDER BY expires_at DESC
       LIMIT 1
    `,
  )
    .bind(state)
    .first<{ value: string }>();
  if (!stored) throw new MicrosoftCallbackRelayError();
  try {
    const payload = JSON.parse(stored.value) as {
      oauthState?: unknown;
      expiresAt?: unknown;
    };
    if (
      payload.oauthState !== state ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= Date.now()
    ) {
      throw new MicrosoftCallbackRelayError();
    }
  } catch (error) {
    if (error instanceof MicrosoftCallbackRelayError) throw error;
    throw new MicrosoftCallbackRelayError();
  }
}

export function isMicrosoftFormPostCallback(request: Request) {
  return request.method === "POST" && isExactMicrosoftCallback(request);
}

export async function stageMicrosoftFormPostCallback(
  environment: CloudflareEnvironment,
  request: Request,
) {
  if (!isMicrosoftFormPostCallback(request)) {
    throw new MicrosoftCallbackRelayError();
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    throw new MicrosoftCallbackRelayError();
  }
  const bodyBytes = await request.arrayBuffer();
  if (bodyBytes.byteLength > MAXIMUM_CALLBACK_BODY_BYTES) {
    throw new MicrosoftCallbackRelayError();
  }
  const rawBody = new TextDecoder().decode(bodyBytes);
  const relayId = randomRelayId();
  const payload = boundedCallbackPayload(new URLSearchParams(rawBody), relayId);
  await assertUnexpiredOAuthState(environment, payload.state);
  const encryptedValue = await encryptRelayPayload(
    requireRelaySecret(environment),
    payload,
  );
  await environment.DB.batch([
    environment.DB.prepare(
      `
        DELETE FROM verification_tokens
         WHERE identifier LIKE 'microsoft-auth-callback-relay:%'
           AND expires_at <= unixepoch()
      `,
    ),
    environment.DB.prepare(
      `
        INSERT INTO verification_tokens (
          id, identifier, value, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, unixepoch() + ?, unixepoch(), unixepoch())
      `,
    ).bind(
      crypto.randomUUID(),
      `${CALLBACK_RELAY_IDENTIFIER_PREFIX}${relayId}`,
      encryptedValue,
      CALLBACK_RELAY_LIFETIME_SECONDS,
    ),
  ]);
  return new Response(null, {
    status: 303,
    headers: {
      "cache-control": "no-store",
      location: `${MICROSOFT_AUTH_CALLBACK_PATH}?relay=${relayId}`,
      "referrer-policy": "no-referrer",
    },
  });
}

export async function consumeMicrosoftCallbackRelay(
  environment: CloudflareEnvironment,
  request: Request,
) {
  if (request.method !== "GET" || !isExactMicrosoftCallback(request)) {
    return null;
  }
  const url = new URL(request.url);
  const relayId = url.searchParams.get("relay");
  if (relayId === null) return null;
  if (
    url.searchParams.getAll("relay").length !== 1 ||
    !CALLBACK_RELAY_ID_PATTERN.test(relayId) ||
    Array.from(url.searchParams.keys()).some((key) => key !== "relay")
  ) {
    throw new MicrosoftCallbackRelayError();
  }
  const stored = await environment.DB.prepare(
    `
      DELETE FROM verification_tokens
       WHERE identifier = ?
         AND expires_at > unixepoch()
      RETURNING value
    `,
  )
    .bind(`${CALLBACK_RELAY_IDENTIFIER_PREFIX}${relayId}`)
    .first<{ value: string }>();
  if (!stored) throw new MicrosoftCallbackRelayError();
  const payload = await decryptRelayPayload(
    requireRelaySecret(environment),
    relayId,
    stored.value,
  );
  assertValidStoredPayload(payload, relayId);

  const internalURL = new URL(request.url);
  internalURL.search = "";
  internalURL.searchParams.set("state", payload.state);
  if (payload.code !== undefined) {
    internalURL.searchParams.set("code", payload.code);
  } else {
    internalURL.searchParams.set("error", payload.error!);
    if (payload.errorDescription) {
      internalURL.searchParams.set(
        "error_description",
        payload.errorDescription,
      );
    }
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("content-type");
  return new Request(internalURL, { method: "GET", headers });
}
