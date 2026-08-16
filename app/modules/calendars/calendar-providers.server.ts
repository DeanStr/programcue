import { z } from "zod";

import {
  readBoundedResponseJson,
  readBoundedResponseText,
} from "~/platform/http/read-response";
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

function microsoftLocalDateTime(instant: string, timeZone: string) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime()))
    throw new CalendarProviderConfigurationError(
      "Microsoft 365 calendar dates must be valid instants.",
    );
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    throw new CalendarProviderConfigurationError(
      `Microsoft 365 calendar timezone ${timeZone} is invalid.`,
    );
  }
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const [year, month, day, hour, minute, second] = [
    value("year"),
    value("month"),
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  ];
  if (!year || !month || !day || !hour || !minute || !second) {
    throw new CalendarProviderConfigurationError(
      "Microsoft 365 calendar dates could not be represented in the event timezone.",
    );
  }
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
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
        dateTime: microsoftLocalDateTime(input.startsAtIso, input.timezone),
        timeZone: input.timezone,
      },
      end: {
        dateTime: microsoftLocalDateTime(input.endsAtIso, input.timezone),
        timeZone: input.timezone,
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

async function calendarCredentialKey(base64Key: string | undefined) {
  if (!base64Key?.trim())
    throw new CalendarProviderConfigurationError(
      "CALENDAR_CREDENTIALS_KEY is required for connected calendars.",
    );
  const keyBytes = base64Bytes(base64Key.trim());
  if (keyBytes.byteLength !== 32)
    throw new CalendarProviderConfigurationError(
      "CALENDAR_CREDENTIALS_KEY must be a base64-encoded 32-byte key.",
    );
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export const calendarCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessTokenExpiresAt: z.number().int().positive(),
  tokenType: z.literal("Bearer"),
  calendarId: z.string().min(1).optional(),
});

export type CalendarCredentials = z.infer<typeof calendarCredentialsSchema>;

export async function encryptCalendarCredentials(
  input: CalendarCredentials,
  base64Key: string | undefined,
) {
  const credentials = calendarCredentialsSchema.parse(input);
  const key = await calendarCredentialKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(credentials)),
  );
  return JSON.stringify({
    version: 1,
    iv: bytesBase64(iv),
    ciphertext: bytesBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptCalendarCredentials(
  encrypted: string,
  base64Key: string | undefined,
) {
  const key = await calendarCredentialKey(base64Key);
  let envelope: unknown;
  try {
    envelope = JSON.parse(encrypted);
  } catch {
    throw new CalendarProviderConfigurationError(
      "Connected calendar credentials are not a valid encrypted envelope.",
    );
  }
  const parsed = z
    .object({ version: z.literal(1), iv: z.string(), ciphertext: z.string() })
    .safeParse(envelope);
  if (!parsed.success)
    throw new CalendarProviderConfigurationError(
      "Connected calendar credentials use an unsupported encrypted envelope.",
    );
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64Bytes(parsed.data.iv) },
      key,
      base64Bytes(parsed.data.ciphertext),
    );
    return calendarCredentialsSchema.parse(
      JSON.parse(new TextDecoder().decode(plaintext)),
    );
  } catch (error) {
    if (error instanceof CalendarProviderConfigurationError) throw error;
    throw new CalendarProviderConfigurationError(
      "Connected calendar credentials could not be decrypted.",
    );
  }
}
