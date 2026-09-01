import { z } from "zod";

import {
  readBoundedResponseJson,
  readBoundedResponseText,
} from "~/platform/http/read-response";
import {
  credentialKeyCandidates,
  RotatingCredentialKeyConfigurationError,
  rotatingCredentialKeyring,
} from "~/platform/security/rotating-credential-key.server";
import type { CalendarMethod } from "./calendar-schema";

const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_RESPONSE_MAX_BYTES = 256 * 1_024;

export type CalendarProviderEvent = {
  uid: string;
  title: string;
  description: string;
  location: string;
  startsAtIso: string;
  endsAtIso: string;
  timezone: string;
  attendeeEmail: string;
  attendeeName: string;
  sequence: number;
  method: CalendarMethod;
};

export type CalendarProviderMutation = CalendarProviderEvent & {
  externalEventId?: string | null;
};

export interface DirectCalendarProvider {
  readonly name: "google" | "microsoft";
  apply(input: CalendarProviderMutation): Promise<{ providerEventId: string }>;
}

export type CalendarAttendanceStatus =
  | "accepted"
  | "declined"
  | "tentative"
  | "needs_action"
  | "organizer";

export class CalendarProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarProviderConfigurationError";
  }
}

export class CalendarProviderRequestError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CalendarProviderRequestError";
  }
}

export type CalendarOAuthCallbackPhase =
  | "token-exchange"
  | "profile-request"
  | "profile-parse"
  | "credential-encryption"
  | "connection-lookup"
  | "connection-persistence";

export class CalendarOAuthUnexpectedError extends Error {
  constructor(
    readonly provider: "google" | "microsoft",
    readonly phase: CalendarOAuthCallbackPhase,
    cause: unknown,
  ) {
    super("The calendar OAuth callback failed unexpectedly.", { cause });
    this.name = "CalendarOAuthUnexpectedError";
  }
}

const providerEventIdSchema = z.string().min(1).max(512);
const providerResponseSchema = z
  .object({ id: providerEventIdSchema })
  .passthrough();

function assertProviderEventId(value: string, provider: string) {
  if (!providerEventIdSchema.safeParse(value).success)
    throw new CalendarProviderConfigurationError(
      `The saved ${provider} calendar event identifier is invalid.`,
    );
}

async function stableProviderToken(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function parseProviderResponse(
  provider: string,
  response: Response,
  existingId?: string | null,
  absentIsSuccess = false,
) {
  if (existingId) assertProviderEventId(existingId, provider);
  if (
    absentIsSuccess &&
    existingId &&
    (response.status === 404 || response.status === 410)
  )
    return { providerEventId: existingId };
  if (!response.ok) {
    const body = await readBoundedResponseText(
      response,
      PROVIDER_RESPONSE_MAX_BYTES,
    ).catch(() => "");
    throw new CalendarProviderRequestError(
      provider,
      response.status,
      `${provider} calendar returned HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : "."}`,
    );
  }
  if (response.status === 204 && existingId)
    return { providerEventId: existingId };
  const parsed = providerResponseSchema.safeParse(
    await readBoundedResponseJson(response, PROVIDER_RESPONSE_MAX_BYTES).catch(
      () => null,
    ),
  );
  if (!parsed.success)
    throw new CalendarProviderRequestError(
      provider,
      response.status,
      `${provider} calendar did not return an event id.`,
    );
  return { providerEventId: parsed.data.id };
}

export function microsoftUtcDateTime(instant: string) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime()))
    throw new CalendarProviderConfigurationError(
      "Microsoft 365 calendar dates must be valid instants.",
    );
  return date.toISOString().replace(/\.\d{3}Z$/u, "");
}

export class GoogleCalendarProvider implements DirectCalendarProvider {
  readonly name = "google" as const;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly accessToken: string | undefined,
    private readonly calendarId = "primary",
    fetcher: typeof fetch = fetch,
    private readonly baseUrl = "https://www.googleapis.com/calendar/v3",
  ) {
    this.fetcher = (input, init) => fetcher(input, init);
  }

  async apply(input: CalendarProviderMutation) {
    if (!this.accessToken?.trim())
      throw new CalendarProviderConfigurationError(
        "A Google Calendar OAuth access token is required.",
      );
    if (input.externalEventId)
      assertProviderEventId(input.externalEventId, this.name);
    const base = `${this.baseUrl}/calendars/${encodeURIComponent(this.calendarId)}/events`;
    if (input.method === "CANCEL") {
      if (!input.externalEventId)
        throw new CalendarProviderConfigurationError(
          "Google Calendar cancellation requires the existing provider event id.",
        );
      return parseProviderResponse(
        this.name,
        await this.fetcher(
          `${base}/${encodeURIComponent(input.externalEventId)}`,
          {
            method: "DELETE",
            headers: { authorization: `Bearer ${this.accessToken}` },
            signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
          },
        ),
        input.externalEventId,
        true,
      );
    }
    // A lifecycle sequence is also the provider-create generation. Retries of
    // one attempt converge on the same id, while a REQUEST after a successful
    // cancellation creates a genuinely new event instead of addressing the
    // provider's deleted/tombstoned event.
    const deterministicEventId =
      input.externalEventId ??
      (await stableProviderToken(`${input.uid}:${input.sequence}`));
    const event = {
      summary: input.title,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startsAtIso, timeZone: input.timezone },
      end: { dateTime: input.endsAtIso, timeZone: input.timezone },
      attendees: [
        { email: input.attendeeEmail, displayName: input.attendeeName },
      ],
      extendedProperties: {
        private: { programCueSequence: String(input.sequence) },
      },
    };
    const body = JSON.stringify({
      ...(!input.externalEventId ? { id: deterministicEventId } : {}),
      ...event,
    });
    const url = input.externalEventId
      ? `${base}/${encodeURIComponent(input.externalEventId)}?sendUpdates=all`
      : `${base}?sendUpdates=all`;
    const response = await this.fetcher(url, {
      method: input.externalEventId ? "PUT" : "POST",
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      body,
    });
    // A 409 proves the deterministic event already exists, but not that it has
    // this lifecycle attempt's content. Reconcile it before reporting success.
    if (!input.externalEventId && response.status === 409) {
      return parseProviderResponse(
        this.name,
        await this.fetcher(
          `${base}/${encodeURIComponent(deterministicEventId)}?sendUpdates=all`,
          {
            method: "PUT",
            headers: {
              authorization: `Bearer ${this.accessToken}`,
              "content-type": "application/json",
            },
            signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
            body: JSON.stringify(event),
          },
        ),
        deterministicEventId,
      );
    }
    return parseProviderResponse(this.name, response, input.externalEventId);
  }

  async attendance(externalEventId: string, attendeeEmail: string) {
    if (!this.accessToken?.trim())
      throw new CalendarProviderConfigurationError(
        "A Google Calendar OAuth access token is required.",
      );
    assertProviderEventId(externalEventId, this.name);
    const response = await this.fetcher(
      `${this.baseUrl}/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(externalEventId)}`,
      {
        headers: { authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      const body = await readBoundedResponseText(
        response,
        PROVIDER_RESPONSE_MAX_BYTES,
      ).catch(() => "");
      throw new CalendarProviderRequestError(
        this.name,
        response.status,
        `google calendar returned HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : "."}`,
      );
    }
    const parsed = z
      .object({
        attendees: z
          .array(
            z.object({
              email: z.email(),
              responseStatus: z.enum([
                "accepted",
                "declined",
                "tentative",
                "needsAction",
              ]),
            }),
          )
          .default([]),
      })
      .safeParse(
        await readBoundedResponseJson(
          response,
          PROVIDER_RESPONSE_MAX_BYTES,
        ).catch(() => null),
      );
    if (!parsed.success)
      throw new CalendarProviderRequestError(
        this.name,
        response.status,
        "Google Calendar returned invalid attendee status.",
      );
    const attendee = parsed.data.attendees.find(
      (candidate) =>
        candidate.email.toLowerCase() === attendeeEmail.toLowerCase(),
    );
    if (!attendee)
      throw new CalendarProviderRequestError(
        this.name,
        response.status,
        "Google Calendar event no longer contains the expected attendee.",
      );
    return (
      attendee.responseStatus === "needsAction"
        ? "needs_action"
        : attendee.responseStatus
    ) satisfies CalendarAttendanceStatus;
  }
}

export class MicrosoftCalendarProvider implements DirectCalendarProvider {
  readonly name = "microsoft" as const;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly accessToken: string | undefined,
    fetcher: typeof fetch = fetch,
    private readonly baseUrl = "https://graph.microsoft.com/v1.0/me/events",
  ) {
    this.fetcher = (input, init) => fetcher(input, init);
  }

  async apply(input: CalendarProviderMutation) {
    if (!this.accessToken?.trim())
      throw new CalendarProviderConfigurationError(
        "A Microsoft 365 OAuth access token is required.",
      );
    if (input.externalEventId)
      assertProviderEventId(input.externalEventId, this.name);
    if (input.method === "CANCEL") {
      if (!input.externalEventId)
        throw new CalendarProviderConfigurationError(
          "Microsoft 365 cancellation requires the existing provider event id.",
        );
      return parseProviderResponse(
        this.name,
        await this.fetcher(
          `${this.baseUrl}/${encodeURIComponent(input.externalEventId)}`,
          {
            method: "DELETE",
            headers: { authorization: `Bearer ${this.accessToken}` },
            signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
          },
        ),
        input.externalEventId,
        true,
      );
    }
    const event = {
      subject: input.title,
      body: { contentType: "text", content: input.description },
      location: { displayName: input.location },
      start: {
        dateTime: microsoftUtcDateTime(input.startsAtIso),
        timeZone: "UTC",
      },
      end: {
        dateTime: microsoftUtcDateTime(input.endsAtIso),
        timeZone: "UTC",
      },
      attendees: [
        {
          emailAddress: {
            address: input.attendeeEmail,
            name: input.attendeeName,
          },
          type: "required",
        },
      ],
    };
    if (input.externalEventId) {
      return parseProviderResponse(
        this.name,
        await this.fetcher(
          `${this.baseUrl}/${encodeURIComponent(input.externalEventId)}`,
          {
            method: "PATCH",
            headers: {
              authorization: `Bearer ${this.accessToken}`,
              "content-type": "application/json",
            },
            signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
            body: JSON.stringify(event),
          },
        ),
        input.externalEventId,
      );
    }

    // transactionId identifies this provider-create attempt. Queue retries keep
    // the sequence stable, while a recreate after cancellation uses a new key.
    const created = await parseProviderResponse(
      this.name,
      await this.fetcher(this.baseUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          ...event,
          transactionId: `programcue-${await stableProviderToken(`${input.uid}:${input.sequence}`)}`,
        }),
      }),
    );
    if (input.sequence === 0) return created;

    // A deduplicated POST can return the pre-existing event unchanged. Apply
    // the current sequence explicitly once its provider identity is recovered.
    return parseProviderResponse(
      this.name,
      await this.fetcher(
        `${this.baseUrl}/${encodeURIComponent(created.providerEventId)}`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            "content-type": "application/json",
          },
          signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
          body: JSON.stringify(event),
        },
      ),
      created.providerEventId,
    );
  }

  async attendance(externalEventId: string, attendeeEmail: string) {
    if (!this.accessToken?.trim())
      throw new CalendarProviderConfigurationError(
        "A Microsoft 365 OAuth access token is required.",
      );
    assertProviderEventId(externalEventId, this.name);
    const response = await this.fetcher(
      `${this.baseUrl}/${encodeURIComponent(externalEventId)}?$select=attendees`,
      {
        headers: { authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      const body = await readBoundedResponseText(
        response,
        PROVIDER_RESPONSE_MAX_BYTES,
      ).catch(() => "");
      throw new CalendarProviderRequestError(
        this.name,
        response.status,
        `microsoft calendar returned HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : "."}`,
      );
    }
    const parsed = z
      .object({
        attendees: z
          .array(
            z.object({
              emailAddress: z.object({ address: z.email() }),
              status: z.object({
                response: z.enum([
                  "accepted",
                  "declined",
                  "tentativelyAccepted",
                  "none",
                  "notResponded",
                  "organizer",
                ]),
              }),
            }),
          )
          .default([]),
      })
      .safeParse(
        await readBoundedResponseJson(
          response,
          PROVIDER_RESPONSE_MAX_BYTES,
        ).catch(() => null),
      );
    if (!parsed.success)
      throw new CalendarProviderRequestError(
        this.name,
        response.status,
        "Microsoft 365 returned invalid attendee status.",
      );
    const attendee = parsed.data.attendees.find(
      (candidate) =>
        candidate.emailAddress.address.toLowerCase() ===
        attendeeEmail.toLowerCase(),
    );
    if (!attendee)
      throw new CalendarProviderRequestError(
        this.name,
        response.status,
        "Microsoft 365 event no longer contains the expected attendee.",
      );
    const status = attendee.status.response;
    return (
      status === "tentativelyAccepted"
        ? "tentative"
        : status === "none" || status === "notResponded"
          ? "needs_action"
          : status
    ) satisfies CalendarAttendanceStatus;
  }
}

function base64Bytes(value: string) {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new CalendarProviderConfigurationError(
      "Calendar credentials contain invalid base64 data.",
    );
  }
}

function bytesBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function calendarCredentialKeyring(
  base64Key: string | undefined,
  previousBase64Key?: string,
) {
  try {
    return await rotatingCredentialKeyring(
      base64Key,
      previousBase64Key,
      "CALENDAR_CREDENTIALS_KEY",
    );
  } catch (error) {
    if (error instanceof RotatingCredentialKeyConfigurationError) {
      throw new CalendarProviderConfigurationError(error.message);
    }
    throw error;
  }
}

export const calendarCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessTokenExpiresAt: z.number().int().positive(),
  tokenType: z.literal("Bearer"),
  calendarId: z.string().min(1).optional(),
});

export type CalendarCredentials = z.infer<typeof calendarCredentialsSchema>;

export type CalendarCredentialContext = {
  connectionId: string;
  organisationId: string;
  provider: "google" | "microsoft";
};

const calendarCredentialGenerationSchema = z.string().regex(/^[a-f0-9]{32}$/u);

function bytesHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function calendarCredentialGeneration(encrypted: string) {
  try {
    const envelope = z
      .object({
        version: z.literal(2),
        generation: calendarCredentialGenerationSchema,
      })
      .parse(JSON.parse(encrypted));
    return envelope.generation;
  } catch {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(encrypted),
    );
    return bytesHex(new Uint8Array(digest).slice(0, 16));
  }
}

function calendarCredentialAdditionalData(
  context: CalendarCredentialContext,
  generation: string,
) {
  return new TextEncoder().encode(
    JSON.stringify([
      "calendar-credentials",
      2,
      context.organisationId,
      context.connectionId,
      context.provider,
      generation,
    ]),
  );
}

export async function encryptCalendarCredentials(
  input: CalendarCredentials,
  base64Key: string | undefined,
  context: CalendarCredentialContext,
  preservedGeneration?: string,
) {
  const credentials = calendarCredentialsSchema.parse(input);
  const generation = calendarCredentialGenerationSchema.parse(
    preservedGeneration ?? bytesHex(crypto.getRandomValues(new Uint8Array(16))),
  );
  const { active } = await calendarCredentialKeyring(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: calendarCredentialAdditionalData(context, generation),
    },
    active.key,
    new TextEncoder().encode(JSON.stringify(credentials)),
  );
  return JSON.stringify({
    version: 2,
    keyId: active.id,
    generation,
    iv: bytesBase64(iv),
    ciphertext: bytesBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptCalendarCredentials(
  encrypted: string,
  base64Key: string | undefined,
  context: CalendarCredentialContext,
  previousBase64Key?: string,
) {
  let envelope: unknown;
  try {
    envelope = JSON.parse(encrypted);
  } catch {
    throw new CalendarProviderConfigurationError(
      "Connected calendar credentials are not a valid encrypted envelope.",
    );
  }
  const parsed = z
    .discriminatedUnion("version", [
      z.object({
        version: z.literal(1),
        iv: z.string(),
        ciphertext: z.string(),
      }),
      z.object({
        version: z.literal(2),
        keyId: z.string().length(16),
        generation: calendarCredentialGenerationSchema,
        iv: z.string(),
        ciphertext: z.string(),
      }),
    ])
    .safeParse(envelope);
  if (!parsed.success)
    throw new CalendarProviderConfigurationError(
      "Connected calendar credentials use an unsupported encrypted envelope.",
    );
  const keyring = await calendarCredentialKeyring(base64Key, previousBase64Key);
  let candidates = keyring.candidates;
  try {
    candidates = credentialKeyCandidates(
      keyring,
      parsed.data.version === 2 ? parsed.data.keyId : null,
    );
  } catch (error) {
    if (error instanceof RotatingCredentialKeyConfigurationError) {
      throw new CalendarProviderConfigurationError(error.message);
    }
    throw error;
  }
  for (const candidate of candidates) {
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64Bytes(parsed.data.iv),
          ...(parsed.data.version === 2
            ? {
                additionalData: calendarCredentialAdditionalData(
                  context,
                  parsed.data.generation,
                ),
              }
            : {}),
        },
        candidate.key,
        base64Bytes(parsed.data.ciphertext),
      );
      return calendarCredentialsSchema.parse(
        JSON.parse(new TextDecoder().decode(plaintext)),
      );
    } catch {
      // Version 1 has no key id or connection binding. It remains readable only
      // long enough for the scheduled version-2 rewrap to complete.
    }
  }
  throw new CalendarProviderConfigurationError(
    "Connected calendar credentials could not be decrypted.",
  );
}

export async function activeCalendarCredentialKeyId(
  base64Key: string | undefined,
) {
  return (await calendarCredentialKeyring(base64Key)).active.id;
}
