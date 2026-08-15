import { z } from "zod";

import {
  eventFilePolicySchema,
  type EventFilePolicy,
} from "~/modules/files/file-policy";

export function isSupportedIanaTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export const timezoneSchema = z
  .string()
  .trim()
  .min(1, "Event timezone is required.")
  .max(100)
  .refine(
    isSupportedIanaTimezone,
    "Choose a valid IANA timezone such as America/Toronto or UTC.",
  );

const configurationKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Use lowercase letters, numbers and hyphens.",
  );

export const eventResourceSchema = z
  .string()
  .trim()
  .min(1, "Resource names cannot be empty.")
  .max(80)
  .regex(
    /^[a-z0-9]+(?:[ -][a-z0-9]+)*$/i,
    "Use letters, numbers, spaces and hyphens for resources.",
  )
  .transform((value) => value.toLowerCase());

export const sessionFormatInputSchema = z.object({
  key: configurationKeySchema,
  label: z.string().trim().min(1, "Every format needs a label.").max(80),
  defaultDurationMinutes: z.coerce.number().int().min(5).max(480),
  position: z.coerce.number().int().min(0),
});

export function normalizeSessionFormatReference(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function hasCrossCollidingSessionFormatReference(
  formats: ReadonlyArray<{ key: string; label: string }>,
) {
  const keys = new Set(formats.map((format) => format.key));
  return formats.some((format) => {
    const labelKey = normalizeSessionFormatReference(format.label);
    return labelKey !== format.key && keys.has(labelKey);
  });
}

export const trackInputSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().trim().min(1, "Every track needs a name.").max(120),
  slug: configurationKeySchema,
  colourToken: z
    .union(
      [
        z
          .string()
          .regex(
            /^#[0-9a-fA-F]{6}$/,
            "Choose a valid track colour in #RRGGBB format.",
          ),
        z.literal(""),
        z.null(),
      ],
      { error: "Choose a valid track colour in #RRGGBB format." },
    )
    .transform((value) => (value ? value.toLowerCase() : null)),
  position: z.coerce.number().int().min(0),
  exclusive: z.boolean(),
  isPublic: z.boolean(),
});

export const roomInputSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().trim().min(1, "Every room needs a name.").max(120),
  capacity: z.coerce
    .number()
    .int()
    .min(1, "Every room needs a positive capacity.")
    .max(100_000),
  resources: z.array(eventResourceSchema).max(50),
  position: z.coerce.number().int().min(0),
});

export const eventSetupInputSchema = z
  .object({
    revision: z.coerce.number().int().positive(),
    name: z.string().trim().min(1, "Event name is required.").max(160),
    timezone: timezoneSchema,
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    venue: z.string().trim().max(200),
    venueAddress: z.string().trim().max(300),
    venueMapUrl: z
      .union([
        z.literal(""),
        z.url("Enter a valid venue map URL.").startsWith("https://", {
          message: "Venue map URLs must use HTTPS.",
        }),
      ])
      .refine((value) => value.length <= 2_048, "Venue map URL is too long."),
    city: z.string().trim().max(120),
    programmeHeroImageUrl: z
      .union([
        z.literal(""),
        z
          .url("Enter a valid programme hero image URL.")
          .startsWith("https://", {
            message: "Programme hero image URLs must use HTTPS.",
          }),
      ])
      .refine(
        (value) => value.length <= 2_048,
        "Programme hero image URL is too long.",
      ),
    publicSlug: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Use lowercase letters, numbers and hyphens.",
      ),
    brandAccent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Choose a valid brand colour."),
    participantLogoUrl: z
      .union([
        z.literal(""),
        z.url("Enter a valid participant logo URL.").startsWith("https://", {
          message: "Participant logo URLs must use HTTPS.",
        }),
      ])
      .refine(
        (value) => value.length <= 2_048,
        "Participant logo URL is too long.",
      ),
    participantWelcomeText: z.string().trim().max(500),
    participantSupportUrl: z
      .union([
        z.literal(""),
        z.url("Enter a valid participant support URL.").startsWith("https://", {
          message: "Participant support URLs must use HTTPS.",
        }),
      ])
      .refine(
        (value) => value.length <= 2_048,
        "Participant support URL is too long.",
      ),
    description: z.string().trim().max(2_000),
    repositoryProvider: z.enum(["d1", "airtable"]),
    retentionMonths: z.coerce
      .number()
      .pipe(z.union([z.literal(12), z.literal(24), z.literal(36)])),
    submissionAccessMode: z.enum([
      "email_verified",
      "account_required",
      "password_protected",
    ]),
    allowAnonymousDrafts: z.boolean(),
    duplicatePersonWarnings: z.boolean(),
    filePolicy: eventFilePolicySchema,
    rooms: z.array(roomInputSchema).max(100),
    tracks: z.array(trackInputSchema).max(100),
    sessionFormats: z.array(sessionFormatInputSchema).min(1).max(50),
  })
  .superRefine((value, context) => {
    if (value.endDate < value.startDate) {
      context.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "End date cannot be before the start date.",
      });
    }
    const uniqueIds = new Set(value.rooms.map((room) => room.id));
    if (uniqueIds.size !== value.rooms.length) {
      context.addIssue({
        code: "custom",
        path: ["rooms"],
        message: "Room identifiers must be unique.",
      });
    }
    for (const [index, room] of value.rooms.entries()) {
      if (new Set(room.resources).size !== room.resources.length) {
        context.addIssue({
          code: "custom",
          path: ["rooms", index, "resources"],
          message: "A room cannot list the same resource more than once.",
        });
      }
    }
    const trackIds = new Set(value.tracks.map((track) => track.id));
    const trackSlugs = new Set(value.tracks.map((track) => track.slug));
    const trackNames = new Set(
      value.tracks.map((track) => track.name.toLowerCase()),
    );
    if (
      trackIds.size !== value.tracks.length ||
      trackSlugs.size !== value.tracks.length ||
      trackNames.size !== value.tracks.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["tracks"],
        message: "Track identifiers, slugs and names must be unique.",
      });
    }
    const formatKeys = new Set(
      value.sessionFormats.map((format) => format.key),
    );
    const formatLabels = new Set(
      value.sessionFormats.map((format) => format.label.toLowerCase()),
    );
    if (
      formatKeys.size !== value.sessionFormats.length ||
      formatLabels.size !== value.sessionFormats.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["sessionFormats"],
        message: "Session format keys and labels must be unique.",
      });
    }
    if (hasCrossCollidingSessionFormatReference(value.sessionFormats)) {
      context.addIssue({
        code: "custom",
        path: ["sessionFormats"],
        message:
          "A session format label cannot resolve to another format's key.",
      });
    }
  });

export const administratorInvitationSchema = z.object({
  name: z.string().trim().min(1, "Administrator name is required.").max(120),
  email: z
    .email("Enter a valid administrator email address.")
    .transform((value) => value.toLowerCase()),
  scope: z.enum(["event", "organisation"]),
});

export const administratorRevocationSchema = z.object({
  membershipId: z.string().trim().min(1).max(128),
});

export type EventSetupInput = z.infer<typeof eventSetupInputSchema>;
export type { EventFilePolicy };
export type AdministratorInvitationInput = z.infer<
  typeof administratorInvitationSchema
>;
