import { z } from "zod";

export const MAX_SPEAKER_BLACKOUT_WINDOWS = 50;
export const MAX_SPEAKER_BLACKOUT_NOTE_LENGTH = 500;

const calendarDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Choose a valid date.");

const clockSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/u, "Choose a valid time.");

const optionalClockSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  clockSchema.optional(),
);

export const speakerBlackoutCreateSchema = z
  .object({
    eventRevision: z.coerce.number().int().positive(),
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    startTime: optionalClockSchema,
    endTime: optionalClockSchema,
    allDay: z.preprocess(
      (value) => value === "on" || value === "true" || value === true,
      z.boolean(),
    ),
    note: z.preprocess(
      (value) => (typeof value === "string" ? value : ""),
      z.string().max(MAX_SPEAKER_BLACKOUT_NOTE_LENGTH),
    ),
  })
  .superRefine((value, context) => {
    if (value.endDate < value.startDate) {
      context.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "The unavailable period must end after it starts.",
      });
    }
    if (value.allDay) return;
    if (!value.startTime) {
      context.addIssue({
        code: "custom",
        path: ["startTime"],
        message: "Choose a start time, or mark the period as all day.",
      });
    }
    if (!value.endTime) {
      context.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "Choose an end time, or mark the period as all day.",
      });
    }
  });

export const speakerBlackoutDeleteSchema = z.object({
  eventRevision: z.coerce.number().int().positive(),
  windowId: z.string().trim().min(1).max(128),
  confirmation: z.literal("delete"),
});
