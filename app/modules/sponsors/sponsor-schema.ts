import { z } from "zod";
import { directSessionSchema } from "~/modules/submissions/submission-service-foundation.server";

const webUrl = z
  .union([
    z.literal(""),
    z
      .url()
      .max(2048)
      .refine(
        (value) => new URL(value).protocol === "https:",
        "Use an HTTPS URL.",
      ),
  ])
  .default("");
export const sponsorProfileSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(3000).default(""),
  websiteUrl: webUrl,
  logoUrl: webUrl,
});
export const sponsorshipSchema = sponsorProfileSchema.extend({
  tier: z.string().trim().max(80).default(""),
  sessionLimit: z.coerce.number().int().min(0).max(100),
  closesAt: z.number().int().positive().nullable(),
});
export const sponsorContactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().toLowerCase().max(254),
});
export const sponsorSessionSchema = directSessionSchema.omit({
  idempotencyKey: true,
});
export type SponsorSessionDetails = z.infer<typeof sponsorSessionSchema>;
export class SponsorStateError extends Error {}
export type SponsorPerson = {
  personId: string;
  email: string;
  restrictedOrganisationId: string | null;
};
