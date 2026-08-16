import { z } from "zod";

export function normalizeSpeakerLinkedinUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      (url.hostname !== "linkedin.com" &&
        !url.hostname.endsWith(".linkedin.com")) ||
      url.username ||
      url.password ||
      url.port
    ) {
      return trimmed;
    }
    url.protocol = "https:";
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function normalizeSpeakerXHandle(value: string) {
  const trimmed = value.trim();
  const directHandle = trimmed.replace(/^@/u, "");
  if (/^[A-Za-z0-9_]{1,15}$/u.test(directHandle)) return directHandle;
  try {
    const url = new URL(trimmed);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
        url.hostname,
      ) ||
      url.username ||
      url.password ||
      url.port
    ) {
      return trimmed;
    }
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length !== 1) return trimmed;
    const handle = pathParts[0] ?? "";
    return /^[A-Za-z0-9_]{1,15}$/u.test(handle) ? handle : trimmed;
  } catch {
    return trimmed;
  }
}

export function formatSpeakerXHandleInput(value: string) {
  const normalized = normalizeSpeakerXHandle(value);
  return /^[A-Za-z0-9_]{1,15}$/u.test(normalized)
    ? `@${normalized}`
    : normalized;
}

export const speakerLinkedinUrlSchema = z
  .string()
  .trim()
  .max(500, "LinkedIn URL must be 500 characters or fewer.")
  .transform(normalizeSpeakerLinkedinUrl)
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
  .max(500, "X profile input must be 500 characters or fewer.")
  .transform(normalizeSpeakerXHandle)
  .refine(
    (value) => value === "" || /^[A-Za-z0-9_]{1,15}$/u.test(value),
    "Enter an X handle or a complete x.com or twitter.com profile URL.",
  );

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
