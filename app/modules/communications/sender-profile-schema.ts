import { z } from "zod";

export const saveSenderProfileSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(120),
  fromName: z.string().trim().min(1).max(120),
  fromEmail: z.email().transform((value) => value.toLowerCase()),
  replyToEmail: z
    .union([z.email(), z.literal("")])
    .transform((value) => (value ? value.toLowerCase() : null)),
});

export const senderProfileIdSchema = z.uuid();

export type SaveSenderProfileInput = z.input<typeof saveSenderProfileSchema>;
