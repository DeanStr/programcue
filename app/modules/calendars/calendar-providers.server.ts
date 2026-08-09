import { z } from "zod";

import type { CalendarMethod } from "./calendar-schema";

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

const providerResponseSchema = z
  .object({ id: z.string().min(1) })
  .passthrough();

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
  if (
    absentIsSuccess &&
    existingId &&
    (response.status === 404 || response.status === 410)
  )
    return { providerEventId: existingId };
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new CalendarProviderRequestError(
      provider,
      response.status,
      `${provider} calendar returned HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : "."}`,
    );
  }
  if (response.status === 204 && existingId)
    return { providerEventId: existingId };
  const parsed = providerResponseSchema.safeParse(
    await response.json().catch(() => null),
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

  constructor(
    private readonly accessToken: string | undefined,
    private readonly calendarId = "primary",
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = "https://www.googleapis.com/calendar/v3",
  ) {}

  async apply(input: CalendarProviderMutation) {
    if (!this.accessToken?.trim())
      throw new CalendarProviderConfigurationError(
        "A Google Calendar OAuth access token is required.",
      );
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
            body: JSON.stringify(event),
          },
        ),
        deterministicEventId,
      );
    }
    return parseProviderResponse(this.name, response, input.externalEventId);
  }
}

export class MicrosoftCalendarProvider implements DirectCalendarProvider {
  readonly name = "microsoft" as const;

  constructor(
    private readonly accessToken: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = "https://graph.microsoft.com/v1.0/me/events",
  ) {}

  async apply(input: CalendarProviderMutation) {
    if (!this.accessToken?.trim())
      throw new CalendarProviderConfigurationError(
        "A Microsoft 365 OAuth access token is required.",
      );
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
          body: JSON.stringify(event),
        },
      ),
      created.providerEventId,
    );
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

export async function decryptCalendarCredentials(
  encrypted: string,
  base64Key: string | undefined,
) {
  if (!base64Key?.trim())
    throw new CalendarProviderConfigurationError(
      "CALENDAR_CREDENTIALS_KEY is required for connected calendars.",
    );
  const keyBytes = base64Bytes(base64Key);
  if (keyBytes.byteLength !== 32)
    throw new CalendarProviderConfigurationError(
      "CALENDAR_CREDENTIALS_KEY must be a base64-encoded 32-byte key.",
    );
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
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64Bytes(parsed.data.iv) },
      key,
      base64Bytes(parsed.data.ciphertext),
    );
    return z
      .object({
        accessToken: z.string().min(1),
        calendarId: z.string().optional(),
      })
      .parse(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch (error) {
    if (error instanceof CalendarProviderConfigurationError) throw error;
    throw new CalendarProviderConfigurationError(
      "Connected calendar credentials could not be decrypted.",
    );
  }
}
