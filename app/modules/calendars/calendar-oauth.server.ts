import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import { safeReturnTo } from "~/platform/auth/return-to";
import { readBoundedResponseJson } from "~/platform/http/read-response";
import {
  type CalendarCredentials,
  type CalendarOAuthCallbackPhase,
  CalendarOAuthUnexpectedError,
  CalendarProviderConfigurationError,
  CalendarProviderRequestError,
  decryptCalendarCredentials,
  encryptCalendarCredentials,
} from "./calendar-providers.server";

export type DirectCalendarProviderName = "google" | "microsoft";
const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_RESPONSE_MAX_BYTES = 256 * 1_024;

type OAuthEnvironment = CloudflareEnvironment & {
  GOOGLE_CALENDAR_CLIENT_ID?: string;
  GOOGLE_CALENDAR_CLIENT_SECRET?: string;
  MICROSOFT_CALENDAR_CLIENT_ID?: string;
  MICROSOFT_CALENDAR_CLIENT_SECRET?: string;
};

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(32_768),
  refresh_token: z.string().min(1).max(32_768).optional(),
  expires_in: z.number().int().positive(),
  token_type: z
    .string()
    .refine((value) => value.toLowerCase() === "bearer", {
      message: "Only Bearer OAuth access tokens are supported.",
    })
    .transform(() => "Bearer" as const),
});

const googleProfileSchema = z.object({
  sub: z.string().min(1).max(512),
  email: z.email().max(320),
});

const calendarAccountEmailSchema = z.email().max(320);

const microsoftProfileSchema = z.object({
  id: z.string().min(1).max(512),
  mail: z.string().max(320).nullable().optional(),
  userPrincipalName: z.string().max(320).nullable().optional(),
});

const statePayloadSchema = z.object({
  version: z.literal(1),
  provider: z.enum(["google", "microsoft"]),
  organisationId: z.string().min(1),
  eventId: z.string().min(1),
  personId: z.string().min(1),
  verifier: z.string().min(43).max(128),
  nonce: z.string().min(16),
  returnTo: z.string().startsWith("/").max(500),
  expiresAt: z.number().int().positive(),
});

const stateEnvelopeSchema = z.object({
  version: z.literal(1),
  iv: z.string(),
  ciphertext: z.string(),
});

function required(value: string | undefined, name: string) {
  if (!value?.trim())
    throw new CalendarProviderConfigurationError(`${name} is required.`);
  return value.trim();
}

function bytesBase64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlBytes(value: string) {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new CalendarProviderConfigurationError(
      "Calendar OAuth state is malformed.",
    );
  }
}

async function stateKey(base64Key: string | undefined) {
  const value = required(base64Key, "CALENDAR_CREDENTIALS_KEY");
  let bytes: Uint8Array;
  try {
    const binary = atob(value);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new CalendarProviderConfigurationError(
      "CALENDAR_CREDENTIALS_KEY must be valid base64.",
    );
  }
  if (bytes.byteLength !== 32)
    throw new CalendarProviderConfigurationError(
      "CALENDAR_CREDENTIALS_KEY must be a base64-encoded 32-byte key.",
    );
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes).buffer,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

async function sealState(
  payload: z.infer<typeof statePayloadSchema>,
  keyValue: string | undefined,
) {
  const key = await stateKey(keyValue);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return bytesBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        iv: bytesBase64Url(iv),
        ciphertext: bytesBase64Url(new Uint8Array(ciphertext)),
      }),
    ),
  );
}

async function openState(token: string, keyValue: string | undefined) {
  const key = await stateKey(keyValue);
  try {
    const envelope = stateEnvelopeSchema.parse(
      JSON.parse(new TextDecoder().decode(base64UrlBytes(token))),
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlBytes(envelope.iv) },
      key,
      base64UrlBytes(envelope.ciphertext),
    );
    return statePayloadSchema.parse(
      JSON.parse(new TextDecoder().decode(plaintext)),
    );
  } catch (error) {
    if (error instanceof CalendarProviderConfigurationError) throw error;
    throw new CalendarProviderConfigurationError(
      "Calendar OAuth state is invalid or has been altered.",
    );
  }
}

async function pkceChallenge(verifier: string) {
  return bytesBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
}

function oauthConfiguration(
  env: OAuthEnvironment,
  provider: DirectCalendarProviderName,
) {
  if (provider === "google")
    return {
      clientId: required(
        env.GOOGLE_CALENDAR_CLIENT_ID,
        "GOOGLE_CALENDAR_CLIENT_ID",
      ),
      clientSecret: required(
        env.GOOGLE_CALENDAR_CLIENT_SECRET,
        "GOOGLE_CALENDAR_CLIENT_SECRET",
      ),
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      profileUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scope:
        "openid email https://www.googleapis.com/auth/calendar.events.owned",
    };
  return {
    clientId: required(
      env.MICROSOFT_CALENDAR_CLIENT_ID,
      "MICROSOFT_CALENDAR_CLIENT_ID",
    ),
    clientSecret: required(
      env.MICROSOFT_CALENDAR_CLIENT_SECRET,
      "MICROSOFT_CALENDAR_CLIENT_SECRET",
    ),
    authorizationUrl:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    profileUrl:
      "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName",
    scope: "openid email offline_access User.Read Calendars.ReadWrite",
  };
}

function callbackUrl(env: OAuthEnvironment) {
  const configured = required(env.BETTER_AUTH_URL, "BETTER_AUTH_URL");
  let origin: URL;
  try {
    origin = new URL(configured);
  } catch {
    throw new CalendarProviderConfigurationError(
      "BETTER_AUTH_URL must be an absolute HTTP(S) URL.",
    );
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password
  )
    throw new CalendarProviderConfigurationError(
      "BETTER_AUTH_URL must be an absolute HTTP(S) URL without embedded credentials.",
    );
  if (origin.protocol !== "https:") {
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (String(env.APP_ENV) === "production" || !local)
      throw new CalendarProviderConfigurationError(
        "BETTER_AUTH_URL must use HTTPS outside local development.",
      );
  }
  return new URL("/oauth/calendar/callback", origin.origin).toString();
}

async function parseTokenResponse(provider: string, response: Response) {
  const body = await readBoundedResponseJson(
    response,
    PROVIDER_RESPONSE_MAX_BYTES,
  ).catch(() => null);
  if (!response.ok) {
    const detail = z
      .object({ error_description: z.string().optional() })
      .safeParse(body);
    throw new CalendarProviderRequestError(
      provider,
      response.status,
      detail.success && detail.data.error_description
        ? detail.data.error_description.slice(0, 500)
        : `${provider} OAuth returned HTTP ${response.status}.`,
    );
  }
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success)
    throw new CalendarProviderRequestError(
      provider,
      response.status,
      `${provider} OAuth did not return valid access-token data.`,
    );
  return parsed.data;
}

function parseMicrosoftAccount(profileBody: unknown) {
  const parsed = microsoftProfileSchema.safeParse(profileBody);
  if (!parsed.success)
    throw new CalendarProviderRequestError(
      "microsoft",
      200,
      "Microsoft account lookup did not return a stable account identifier.",
    );
  const email = [parsed.data.mail, parsed.data.userPrincipalName]
    .map((candidate) => calendarAccountEmailSchema.safeParse(candidate))
    .find((candidate) => candidate.success);
  if (!email?.success)
    throw new CalendarProviderRequestError(
      "microsoft",
      200,
      "Microsoft account lookup did not return a usable email address.",
    );
  return { reference: parsed.data.id, email: email.data };
}

function parseGoogleAccount(profileBody: unknown) {
  const parsed = googleProfileSchema.safeParse(profileBody);
  if (!parsed.success)
    throw new CalendarProviderRequestError(
      "google",
      200,
      "Google account lookup did not return a stable account identifier and email address.",
    );
  return { reference: parsed.data.sub, email: parsed.data.email };
}

async function callbackPhase<T>(
  provider: DirectCalendarProviderName,
  phase: CalendarOAuthCallbackPhase,
  operation: () => T | Promise<T>,
) {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof CalendarProviderConfigurationError ||
      error instanceof CalendarProviderRequestError ||
      error instanceof CalendarOAuthUnexpectedError
    )
      throw error;
    throw new CalendarOAuthUnexpectedError(provider, phase, error);
  }
}

export type CalendarOAuthStart = {
  authorizationUrl: string;
  nonce: string;
  expiresAt: number;
};

export class CalendarOAuthService {
  private readonly oauthEnv: OAuthEnvironment;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly env: CloudflareEnvironment,
    fetcher: typeof fetch = fetch,
  ) {
    this.oauthEnv = env as OAuthEnvironment;
    this.fetcher = (input, init) => fetcher(input, init);
  }

  async start(
    viewer: Viewer,
    provider: DirectCalendarProviderName,
    returnTo = "/admin/communications",
  ): Promise<CalendarOAuthStart> {
    const safeDestination = safeReturnTo(returnTo);
    if (safeDestination !== returnTo)
      throw new CalendarProviderConfigurationError(
        "Calendar OAuth return path must be a safe local application path.",
      );
    const configuration = oauthConfiguration(this.oauthEnv, provider);
    const verifier = bytesBase64Url(crypto.getRandomValues(new Uint8Array(48)));
    const nonce = bytesBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    const expiresAt = Math.floor(Date.now() / 1_000) + 10 * 60;
    const state = await sealState(
      {
        version: 1,
        provider,
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        personId: viewer.personId,
        verifier,
        nonce,
        returnTo: safeDestination,
        expiresAt,
      },
      this.env.CALENDAR_CREDENTIALS_KEY,
    );
    const url = new URL(configuration.authorizationUrl);
    url.search = new URLSearchParams({
      client_id: configuration.clientId,
      redirect_uri: callbackUrl(this.oauthEnv),
      response_type: "code",
      scope: configuration.scope,
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      ...(provider === "google"
        ? { access_type: "offline", prompt: "consent" }
        : { response_mode: "query", prompt: "select_account" }),
    }).toString();
    return { authorizationUrl: url.toString(), nonce, expiresAt };
  }

  async callback(
    viewer: Viewer,
    input: { state: string; code: string; nonce: string },
  ) {
    const state = await this.validateState(viewer, input);
    const configuration = oauthConfiguration(this.oauthEnv, state.provider);
    const token = await callbackPhase(
      state.provider,
      "token-exchange",
      async () =>
        parseTokenResponse(
          state.provider,
          await this.fetcher(configuration.tokenUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: input.code,
              client_id: configuration.clientId,
              client_secret: configuration.clientSecret,
              redirect_uri: callbackUrl(this.oauthEnv),
              code_verifier: state.verifier,
            }),
          }),
        ),
    );
    if (!token.refresh_token)
      throw new CalendarProviderConfigurationError(
        `${state.provider} OAuth did not return a refresh token. Revoke the existing provider grant and consent again.`,
      );
    const refreshToken = token.refresh_token;
    const profileBody = await callbackPhase(
      state.provider,
      "profile-request",
      async () => {
        const response = await this.fetcher(configuration.profileUrl, {
          headers: { authorization: `Bearer ${token.access_token}` },
          signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
        });
        if (!response.ok)
          throw new CalendarProviderRequestError(
            state.provider,
            response.status,
            `${state.provider} account lookup returned HTTP ${response.status}.`,
          );
        return readBoundedResponseJson(
          response,
          PROVIDER_RESPONSE_MAX_BYTES,
        ).catch(() => null);
      },
    );
    const account = await callbackPhase(state.provider, "profile-parse", () =>
      state.provider === "google"
        ? parseGoogleAccount(profileBody)
        : parseMicrosoftAccount(profileBody),
    );
    const expiresAt = Math.floor(Date.now() / 1_000) + token.expires_in;
    const encrypted = await callbackPhase(
      state.provider,
      "credential-encryption",
      () =>
        encryptCalendarCredentials(
          {
            accessToken: token.access_token,
            refreshToken,
            accessTokenExpiresAt: expiresAt,
            tokenType: token.token_type,
            ...(state.provider === "google" ? { calendarId: "primary" } : {}),
          },
          this.env.CALENDAR_CREDENTIALS_KEY,
        ),
    );
    const existing = await callbackPhase(
      state.provider,
      "connection-lookup",
      () =>
        this.env.DB.prepare(
          `SELECT cc.id, cc.organisation_id AS organisationId
         FROM calendar_connections cc
        WHERE cc.person_id = ? AND cc.provider = ?
          AND cc.account_reference = ?`,
        )
          .bind(viewer.personId, state.provider, account.reference)
          .first<{ id: string; organisationId: string }>(),
    );
    if (existing && existing.organisationId !== viewer.organisationId)
      throw new CalendarProviderConfigurationError(
        "This calendar account is already connected for the participant in another organisation.",
      );
    const id = existing?.id ?? crypto.randomUUID();
    const scopes = configuration.scope.split(" ");
    const results = await callbackPhase(
      state.provider,
      "connection-persistence",
      () =>
        this.env.DB.batch([
          this.env.DB.prepare(
            `INSERT INTO calendar_connections (
         id, organisation_id, event_id, person_id, provider, account_reference,
           encrypted_credentials, scopes_json, status, expires_at, created_at, updated_at
         )
         SELECT ?, ?, NULL, ?, ?, ?, ?, ?, 'connected', ?, unixepoch(), unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM events e
             WHERE e.id = ? AND e.organisation_id = ?
          )
         ON CONFLICT(person_id, provider, account_reference) DO UPDATE SET
           event_id = NULL,
           encrypted_credentials = excluded.encrypted_credentials,
           scopes_json = excluded.scopes_json,
           status = 'connected',
           expires_at = excluded.expires_at,
           updated_at = unixepoch()
         WHERE calendar_connections.organisation_id = excluded.organisation_id`,
          ).bind(
            id,
            viewer.organisationId,
            viewer.personId,
            state.provider,
            account.reference,
            encrypted,
            JSON.stringify(scopes),
            expiresAt,
            viewer.eventId,
            viewer.organisationId,
          ),
          this.env.DB.prepare(
            `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
           entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'calendar.connection.connected',
                'calendar_connection', ?, ?, unixepoch()
          WHERE changes() = 1`,
          ).bind(
            crypto.randomUUID(),
            viewer.organisationId,
            viewer.eventId,
            viewer.personId,
            id,
            JSON.stringify({
              provider: state.provider,
              account: account.email,
            }),
          ),
        ]),
    );
    if ((results[0].meta.changes ?? 0) !== 1)
      throw new CalendarProviderConfigurationError(
        "Calendar connection could not be stored in the authorised event.",
      );
    return {
      provider: state.provider,
      account: account.email,
      returnTo: state.returnTo,
    };
  }

  async validateState(
    viewer: Pick<Viewer, "organisationId" | "eventId" | "personId">,
    input: { state: string; nonce: string },
  ) {
    const state = await openState(
      input.state,
      this.env.CALENDAR_CREDENTIALS_KEY,
    );
    if (state.expiresAt <= Math.floor(Date.now() / 1_000))
      throw new CalendarProviderConfigurationError(
        "Calendar OAuth consent expired. Start the connection again.",
      );
    if (state.nonce !== input.nonce)
      throw new CalendarProviderConfigurationError(
        "Calendar OAuth browser state does not match.",
      );
    if (
      state.personId !== viewer.personId ||
      state.eventId !== viewer.eventId ||
      state.organisationId !== viewer.organisationId
    )
      throw new CalendarProviderConfigurationError(
        "Calendar OAuth consent belongs to a different signed-in event participant.",
      );
    return state;
  }

  async refreshConnection(
    viewer: Pick<Viewer, "organisationId" | "eventId" | "personId">,
    connectionId: string,
    minimumLifetimeSeconds = 300,
  ) {
    const connection = await this.env.DB.prepare(
      `SELECT cc.id, cc.provider, cc.encrypted_credentials AS encryptedCredentials,
              cc.expires_at AS expiresAt, cc.status
         FROM calendar_connections cc
         JOIN events e ON e.id = ? AND e.organisation_id = cc.organisation_id
        WHERE cc.id = ? AND e.organisation_id = ? AND cc.person_id = ?
          AND (cc.event_id IS NULL OR cc.event_id = e.id)
          AND cc.status IN ('connected','needs_attention')`,
    )
      .bind(
        viewer.eventId,
        connectionId,
        viewer.organisationId,
        viewer.personId,
      )
      .first<{
        id: string;
        provider: DirectCalendarProviderName;
        encryptedCredentials: string | null;
        expiresAt: number | null;
        status: "connected" | "needs_attention";
      }>();
    if (!connection)
      throw new CalendarProviderConfigurationError(
        "Calendar connection was not found for this event participant.",
      );
    const now = Math.floor(Date.now() / 1_000);
    let current: CalendarCredentials;
    try {
      if (connection.expiresAt === null)
        throw new CalendarProviderConfigurationError(
          "Calendar connection is missing OAuth token expiry and must be connected again.",
        );
      if (!connection.encryptedCredentials)
        throw new CalendarProviderConfigurationError(
          "Calendar connection credentials were erased and the account must be connected again.",
        );
      current = await decryptCalendarCredentials(
        connection.encryptedCredentials,
        this.env.CALENDAR_CREDENTIALS_KEY,
      );
      if (current.accessTokenExpiresAt !== connection.expiresAt)
        throw new CalendarProviderConfigurationError(
          "Calendar credential expiry does not match its durable connection state.",
        );
    } catch (error) {
      await this.env.DB.prepare(
        `UPDATE calendar_connections
            SET status = 'needs_attention', updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND (event_id IS NULL OR event_id = ?)
            AND encrypted_credentials IS ? AND status = ?`,
      )
        .bind(
          connection.id,
          viewer.organisationId,
          viewer.eventId,
          connection.encryptedCredentials,
          connection.status,
        )
        .run();
      throw error;
    }
    if (
      connection.status === "connected" &&
      connection.expiresAt > now + minimumLifetimeSeconds
    )
      return { refreshed: false, expiresAt: connection.expiresAt };
    const configuration = oauthConfiguration(
      this.oauthEnv,
      connection.provider,
    );
    let token: z.infer<typeof tokenResponseSchema>;
    try {
      token = await parseTokenResponse(
        connection.provider,
        await this.fetcher(configuration.tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: current.refreshToken,
            client_id: configuration.clientId,
            client_secret: configuration.clientSecret,
            scope: configuration.scope,
          }),
        }),
      );
    } catch (error) {
      await this.env.DB.prepare(
        `UPDATE calendar_connections
            SET status = 'needs_attention', updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND (event_id IS NULL OR event_id = ?)
            AND encrypted_credentials IS ? AND status = ?`,
      )
        .bind(
          connection.id,
          viewer.organisationId,
          viewer.eventId,
          connection.encryptedCredentials,
          connection.status,
        )
        .run();
      throw error;
    }
    const expiresAt = now + token.expires_in;
    const credentials: CalendarCredentials = {
      ...current,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? current.refreshToken,
      accessTokenExpiresAt: expiresAt,
      tokenType: token.token_type,
    };
    const encrypted = await encryptCalendarCredentials(
      credentials,
      this.env.CALENDAR_CREDENTIALS_KEY,
    );
    const updated = await this.env.DB.prepare(
      `UPDATE calendar_connections
          SET encrypted_credentials = ?, expires_at = ?, status = 'connected',
              updated_at = unixepoch()
        WHERE id = ? AND organisation_id = ? AND person_id = ?
          AND (event_id IS NULL OR event_id = ?)
          AND encrypted_credentials = ?`,
    )
      .bind(
        encrypted,
        expiresAt,
        connection.id,
        viewer.organisationId,
        viewer.personId,
        viewer.eventId,
        connection.encryptedCredentials,
      )
      .run();
    if ((updated.meta.changes ?? 0) !== 1)
      throw new CalendarProviderConfigurationError(
        "Calendar credentials changed while the access token was refreshed.",
      );
    return { refreshed: true, expiresAt };
  }
}
