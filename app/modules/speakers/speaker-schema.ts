import { z } from "zod";

export const speakerLinkedinUrlSchema = z
  .string()
  .trim()
  .max(500, "LinkedIn URL must be 500 characters or fewer.")
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        (url.hostname === "linkedin.com" ||
          url.hostname.endsWith(".linkedin.com"))
      );
    } catch {
      return false;
    }
  }, "Enter a full https://www.linkedin.com profile URL.");

export const speakerXHandleSchema = z
  .string()
  .trim()
  .max(16, "X handle must be 15 characters or fewer, excluding @.")
  .refine(
    (value) => value === "" || /^@?[A-Za-z0-9_]{1,15}$/u.test(value),
    "Enter an X handle using letters, numbers, or underscores.",
  )
  .transform((value) => value.replace(/^@/u, ""));

export const speakerTravelPreferencesSchema = z
  .string()
  .trim()
  .max(
    2_000,
    "Travel and logistics preferences must be 2,000 characters or fewer.",
  );

export const speakerProfileSchema = z.object({
  revision: z.coerce.number().int().positive(),
  name: z.string().trim().min(2, "Enter your name.").max(120),
  biography: z
    .string()
    .trim()
    .min(40, "Biography must be at least 40 characters.")
    .max(5_000, "Biography must be 5,000 characters or fewer."),
  pronunciation: z.string().trim().max(160),
  organisationName: z.string().trim().max(160),
  jobTitle: z.string().trim().max(160),
  linkedinUrl: speakerLinkedinUrlSchema,
  xHandle: speakerXHandleSchema,
  travelPreferences: speakerTravelPreferencesSchema,
  publish: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((value) => value === true || value === "true"),
});

export type SpeakerProfileInput = z.infer<typeof speakerProfileSchema>;
