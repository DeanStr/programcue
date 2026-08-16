import { z } from "zod";

const limitSchema = z
  .string()
  .regex(/^\d+$/u, "limit must be a whole number from 1 to 100")
  .transform(Number)
  .pipe(z.number().int().min(1).max(100))
  .default(50);

const timestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => Math.floor(Date.parse(value) / 1_000));

const sessionFilters = {
  q: z.string().trim().min(1).max(160).optional(),
  track: z.string().trim().min(1).max(120).optional(),
  room: z.string().trim().min(1).max(120).optional(),
  speakerId: z.string().trim().min(1).max(200).optional(),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
};

export const publicProgrammeQuerySchema = z
  .object({
    format: z.enum(["json", "html"]).optional(),
    ...sessionFilters,
  })
  .strict()
  .refine(
    ({ from, to }) => from === undefined || to === undefined || to > from,
    { path: ["to"], message: "to must be after from" },
  );

export const publicSessionQuerySchema = z
  .object({
    ...sessionFilters,
    limit: limitSchema,
    cursor: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .refine(
    ({ from, to }) => from === undefined || to === undefined || to > from,
    { path: ["to"], message: "to must be after from" },
  );

export const publicSpeakerQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(160).optional(),
    sessionId: z.string().trim().min(1).max(200).optional(),
    limit: limitSchema,
    cursor: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export const emptyPublicQuerySchema = z.object({}).strict();

export const PUBLIC_CALENDAR_SESSION_LIMIT = 50;
export const PUBLIC_CALENDAR_SESSION_ID_LIMIT = 200;

export const publicCalendarQuerySchema = z
  .object({
    sessions: z
      .string()
      .trim()
      .min(1)
      .max(
        PUBLIC_CALENDAR_SESSION_LIMIT * PUBLIC_CALENDAR_SESSION_ID_LIMIT +
          (PUBLIC_CALENDAR_SESSION_LIMIT - 1),
      )
      .optional(),
    itinerary: z.literal("mine").optional(),
    share: z.string().max(100).optional(),
  })
  .strict()
  .refine(
    ({ sessions, itinerary, share }) =>
      [sessions, itinerary, share].filter((value) => value !== undefined)
        .length <= 1,
    {
      message:
        "Use only one calendar selection: sessions, itinerary, or share.",
    },
  );
