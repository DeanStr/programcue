import { z } from "zod";

export const schedulePlacementSchema = z.object({
  scheduleVersionId: z.string().trim().min(1),
  scheduleRevision: z.coerce.number().int().positive(),
  sessionId: z.string().trim().min(1),
  roomId: z.string().trim().min(1),
  startsAt: z.coerce.number().int().positive(),
  endsAt: z.coerce.number().int().positive(),
}).refine((value) => value.endsAt > value.startsAt, {
  path: ["endsAt"],
  message: "The session must end after it starts.",
});

export const schedulePublishSchema = z.object({
  scheduleVersionId: z.string().trim().min(1),
  scheduleRevision: z.coerce.number().int().positive(),
});

export type SchedulePlacementInput = z.infer<typeof schedulePlacementSchema>;
export type SchedulePublishInput = z.infer<typeof schedulePublishSchema>;
