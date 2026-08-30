import { z } from "zod";

export type SubmissionApplicationState =
  | "accepting"
  | "not_open"
  | "closed"
  | "full"
  | "person_limit";

type SubmissionAvailabilityInput = {
  status: "draft" | "published" | "closed" | "archived";
  opensAt: number | null;
  closesAt: number | null;
  submissionLimit: number | null;
  perPersonSubmissionLimit: number | null;
  personSubmissionCount?: number | null;
  submittedCount: number;
};

export function submissionApplicationAvailability(
  input: SubmissionAvailabilityInput,
  now = Math.floor(Date.now() / 1_000),
) {
  if (
    input.status === "published" &&
    input.opensAt !== null &&
    input.opensAt > now
  ) {
    return {
      accepting: false as const,
      state: "not_open" as const,
      reason: "Applications for this event are not open yet.",
    };
  }
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
  if (
    input.perPersonSubmissionLimit !== null &&
    input.personSubmissionCount !== null &&
    input.personSubmissionCount !== undefined &&
    input.personSubmissionCount >= input.perPersonSubmissionLimit
  ) {
    return {
      accepting: false as const,
      state: "person_limit" as const,
      reason:
        "You have reached the submission limit for this call for speakers.",
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
  opensAt: z.number().int().nullable().optional().default(null),
  closesAt: z.number().int().nullable(),
  submissionLimit: z.number().int().nonnegative().nullable(),
  perPersonSubmissionLimit: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .default(null),
  submittedCount: z.number().int().nonnegative(),
});

export function parsePublicApplicationProjection(
  value: string | null,
  now = Math.floor(Date.now() / 1_000),
) {
  if (value === null) return null;
  const projection = publicApplicationProjectionSchema.parse(JSON.parse(value));
  const state = submissionApplicationAvailability(
    { ...projection, status: "published" },
    now,
  ).state;
  return {
    url: projection.url,
    state: state === "person_limit" ? ("full" as const) : state,
  };
}
