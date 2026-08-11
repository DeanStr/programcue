import { z } from "zod";

export const calendarProviderSchema = z.enum([
  "email_ics",
  "google",
  "microsoft",
]);
export const calendarMethodSchema = z.enum(["REQUEST", "CANCEL"]);

export const queueCalendarLifecycleSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  personId: z.string().trim().min(1).max(128),
  method: calendarMethodSchema,
  provider: calendarProviderSchema,
  connectionId: z.string().trim().min(1).max(128).optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
});

export const calendarQueueMessageSchema = z.object({
  type: z.literal("calendar.sync"),
  operationId: z.string().min(1),
  invitationId: z.string().min(1),
  attemptId: z.string().min(1),
  eventId: z.string().min(1),
  organisationId: z.string().min(1),
  sessionId: z.string().min(1),
  personId: z.string().min(1),
  provider: calendarProviderSchema,
  connectionId: z.string().min(1).nullable(),
  idempotencyKey: z.string().min(8),
  payload: z.object({
    uid: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    method: calendarMethodSchema,
    title: z.string().min(1),
    description: z.string(),
    location: z.string(),
    startsAt: z.number().int(),
    endsAt: z.number().int(),
    timezone: z.string().min(1),
    attendeeName: z.string().min(1),
    attendeeEmail: z.email(),
    organizerName: z.string().min(1),
    organizerEmail: z.email(),
    brandAccent: z.string().regex(/^#[0-9a-f]{6}$/i),
  }),
});

export const scheduleCalendarFanoutMessageSchema = z.object({
  type: z.literal("schedule.calendar_fanout"),
  operationId: z.string().min(1),
  scheduleVersionId: z.string().min(1),
  eventId: z.string().min(1),
  organisationId: z.string().min(1),
  idempotencyKey: z.string().min(8),
  afterTarget: z.string().max(512).optional(),
});

export type CalendarProviderName = z.infer<typeof calendarProviderSchema>;
export type CalendarMethod = z.infer<typeof calendarMethodSchema>;
export type QueueCalendarLifecycleInput = z.infer<
  typeof queueCalendarLifecycleSchema
>;
export type CalendarQueueMessage = z.infer<typeof calendarQueueMessageSchema>;
export type ScheduleCalendarFanoutMessage = z.infer<
  typeof scheduleCalendarFanoutMessageSchema
>;
