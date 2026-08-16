import { z } from "zod";

export type SubmissionApplicationState = "accepting" | "closed" | "full";

type SubmissionAvailabilityInput = {
  status: "draft" | "published" | "closed" | "archived";
  closesAt: number | null;
  submissionLimit: number | null;
  submittedCount: number;
};

export function submissionApplicationAvailability(
  input: SubmissionAvailabilityInput,
  now = Math.floor(Date.now() / 1_000),
) {
  if (
    input.status !== "published" ||
    (input.closesAt !== null && input.closesAt < now)
  ) {
    return {
      accepting: false as const,
      state: "closed" as const,
      reason: "Applications for this event are closed.",
    };
  }
  if (
    input.submissionLimit !== null &&
    input.submittedCount >= input.submissionLimit
  ) {
    return {
      accepting: false as const,
      state: "full" as const,
      reason: "This call for speakers has reached its submission limit.",
    };
  }
  return {
    accepting: true as const,
    state: "accepting" as const,
    reason: null,
  };
}

const publicApplicationProjectionSchema = z.object({
  url: z.string().min(1),
  closesAt: z.number().int().nullable(),
  submissionLimit: z.number().int().nonnegative().nullable(),
  submittedCount: z.number().int().nonnegative(),
});

export function parsePublicApplicationProjection(
  value: string | null,
  now = Math.floor(Date.now() / 1_000),
) {
  if (value === null) return null;
  const projection = publicApplicationProjectionSchema.parse(JSON.parse(value));
  return {
    url: projection.url,
    state: submissionApplicationAvailability(
      { ...projection, status: "published" },
      now,
    ).state,
  };
}
