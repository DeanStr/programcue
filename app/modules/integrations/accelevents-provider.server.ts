import { z } from "zod";

import { readBoundedResponseText } from "~/platform/http/read-response";

const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_RESPONSE_MAX_BYTES = 1_024 * 1_024;
const MAX_EXTERNAL_ID_LENGTH = 512;
const providerNumericIdSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const speakerCreateResponseSchema = z
  .object({ id: providerNumericIdSchema })
  .passthrough();
const sessionCreateResponseSchema = providerNumericIdSchema;
const trackCreateResponseSchema = providerNumericIdSchema;

export const acceleventsCredentialsSchema = z.object({
  apiKey: z.string().trim().min(1, "An Accelevents API key is required."),
  eventUrl: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
      "Use the event URL identifier, not a full URL.",
    ),
  externalEventId: z.coerce.number().int().positive(),
  sessionTypeFormat: z.enum(["VIRTUAL", "IN_PERSON", "HYBRID"]),
});

export type AcceleventsCredentials = z.infer<
  typeof acceleventsCredentialsSchema
>;

export const acceleventsSpeakerPayloadSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.email(),
  bio: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  allowAttendeeAccess: z.boolean(),
  allowOverrideDetails: z.boolean(),
});

export type AcceleventsSpeakerPayload = z.infer<
  typeof acceleventsSpeakerPayloadSchema
>;

export const acceleventsTrackPayloadSchema = z.object({
  type: z.literal("TRACK"),
  name: z.string().trim().min(1).max(255),
  color: z.string().trim().min(1).optional(),
  description: z.string().trim().optional(),
  position: z.number().finite(),
});

export type AcceleventsTrackPayload = z.infer<
  typeof acceleventsTrackPayloadSchema
>;

export const acceleventsSessionPayloadSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  startTime: z.string().min(1),
  endTime: z.string().min(1),
  format: z.enum([
    "MAIN_STAGE",
    "BREAKOUT_SESSION",
    "MEET_UP",
    "WORKSHOP",
    "EXPO",
    "BREAK",
    "OTHER",
  ]),
  status: z.enum(["VISIBLE", "HIDDEN", "DRAFT"]),
  sessionVisibilityType: z.enum(["PUBLIC", "PRIVATE"]),
  sessionTypeFormat: z.enum(["VIRTUAL", "IN_PERSON", "HYBRID"]),
  location: z.string().optional(),
});

export type AcceleventsSessionPayload = z.infer<
  typeof acceleventsSessionPayloadSchema
>;

export const acceleventsSessionSpeakerAssociationPayloadSchema = z.object({
  sessionId: z.string().min(1),
  speakerId: z.string().min(1),
  position: z.number().int().nonnegative(),
  roleLabel: z.string().trim().min(1).nullable(),
});

export type AcceleventsSessionSpeakerAssociationPayload = z.infer<
  typeof acceleventsSessionSpeakerAssociationPayloadSchema
>;

const listSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
});

export class AcceleventsProviderError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "AcceleventsProviderError";
    this.status = status;
  }
}

export const ACCELEVENTS_TRACK_UPDATE_UNSUPPORTED =
  "Accelevents' published API documents track creation but no track-update endpoint. Update this track in Accelevents or reconnect it after Accelevents publishes a supported write contract.";

export const ACCELEVENTS_SESSION_SPEAKER_WRITE_UNSUPPORTED =
  "Accelevents' published API documents session-speaker reads but no session-speaker association write endpoint. The association was not sent.";

function requireMappedExternalId(
  value: string,
  entityType: "speaker" | "session",
) {
  const id = value.trim();
  if (!id || id.length > MAX_EXTERNAL_ID_LENGTH)
    throw new AcceleventsProviderError(
      `The saved Accelevents ${entityType} identifier is invalid.`,
    );
  return id;
}

export class AcceleventsProvider {
  constructor(
    private readonly credentials: AcceleventsCredentials,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private url(path: string, query?: URLSearchParams) {
    const url = new URL(
      `/rest/host/event/${encodeURIComponent(this.credentials.eventUrl)}${path}`,
      "https://api.accelevents.com",
    );
    if (query) url.search = query.toString();
    return url;
  }

  private async request(
    method: string,
    path: string,
    options: { body?: unknown; query?: URLSearchParams } = {},
  ) {
    const response = await this.fetcher(this.url(path, options.query), {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        Key: this.credentials.apiKey,
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (
        await readBoundedResponseText(
          response,
          PROVIDER_RESPONSE_MAX_BYTES,
        ).catch(() => "")
      )
        .trim()
        .slice(0, 500);
      throw new AcceleventsProviderError(
        `Accelevents returned ${response.status}${detail ? `: ${detail}` : "."}`,
        response.status,
      );
    }
    if (response.status === 204) return null;
    let text: string;
    try {
      text = await readBoundedResponseText(
        response,
        PROVIDER_RESPONSE_MAX_BYTES,
      );
    } catch {
      throw new AcceleventsProviderError(
        "Accelevents returned an oversized response.",
        response.status,
      );
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AcceleventsProviderError(
        "Accelevents returned an invalid JSON response.",
        response.status,
      );
    }
  }

  private listQuery(searchString = "") {
    return new URLSearchParams({
      eventId: String(this.credentials.externalEventId),
      page: "0",
      size: "100",
      expand: "SPEAKER,TRACK",
      ...(searchString ? { searchString } : {}),
    });
  }

  async validateConnection() {
    const response = await this.request("GET", "/session", {
      query: this.listQuery(),
    });
    if (!listSchema.safeParse(response).success) {
      throw new AcceleventsProviderError(
        "Accelevents credentials were accepted but the event response was not recognised.",
      );
    }
  }

  async upsertSpeaker(
    payload: AcceleventsSpeakerPayload,
    mappedExternalId: string | null,
  ) {
    if (mappedExternalId !== null) {
      const mapped = requireMappedExternalId(mappedExternalId, "speaker");
      await this.request("PUT", `/speaker/${encodeURIComponent(mapped)}`, {
        body: payload,
      });
      return mapped;
    }
    const created = await this.request("POST", "/speaker", { body: payload });
    const parsed = speakerCreateResponseSchema.safeParse(created);
    if (!parsed.success)
      throw new AcceleventsProviderError(
        "Accelevents created the speaker without returning the documented numeric id response.",
      );
    return String(parsed.data.id);
  }

  async upsertSession(
    payload: AcceleventsSessionPayload,
    mappedExternalId: string | null,
  ) {
    if (mappedExternalId !== null) {
      const mapped = requireMappedExternalId(mappedExternalId, "session");
      await this.request("PUT", `/session/${encodeURIComponent(mapped)}`, {
        body: payload,
      });
      return mapped;
    }
    const created = await this.request("POST", "/session", { body: payload });
    const parsed = sessionCreateResponseSchema.safeParse(created);
    if (!parsed.success)
      throw new AcceleventsProviderError(
        "Accelevents created the session without returning the documented numeric id response.",
      );
    return String(parsed.data);
  }

  async createTrack(payload: AcceleventsTrackPayload) {
    const created = await this.request("POST", "/key-value", {
      body: payload,
    });
    const parsed = trackCreateResponseSchema.safeParse(created);
    if (!parsed.success)
      throw new AcceleventsProviderError(
        "Accelevents created the track without returning the documented numeric id response.",
      );
    return String(parsed.data);
  }

  async updateTrack(
    _payload: AcceleventsTrackPayload,
    _mappedExternalId: string,
  ): Promise<string> {
    throw new AcceleventsProviderError(ACCELEVENTS_TRACK_UPDATE_UNSUPPORTED);
  }

  async associateSessionSpeaker(
    _sessionExternalId: string,
    _speakerExternalId: string,
    _payload: AcceleventsSessionSpeakerAssociationPayload,
  ): Promise<string> {
    throw new AcceleventsProviderError(
      ACCELEVENTS_SESSION_SPEAKER_WRITE_UNSUPPORTED,
    );
  }
}
