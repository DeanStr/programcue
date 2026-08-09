import { z } from "zod";

export const speakerProfileSchema = z.object({
  revision: z.coerce.number().int().positive(),
  name: z.string().trim().min(2, "Enter your name.").max(120),
  biography: z
    .string()
    .trim()
    .min(40, "Biography must be at least 40 characters.")
    .max(2_000),
  pronunciation: z.string().trim().max(160),
  organisationName: z.string().trim().max(160),
  jobTitle: z.string().trim().max(160),
  publish: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((value) => value === true || value === "true"),
});

export type SpeakerProfileInput = z.infer<typeof speakerProfileSchema>;
