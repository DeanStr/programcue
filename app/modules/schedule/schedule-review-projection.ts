import { z } from "zod";

import { timezoneSchema } from "~/modules/events/event-schema";

export const SCHEDULE_REVIEW_PROJECTION_SCHEMA_VERSION = 1;
export const SCHEDULE_REVIEW_PROJECTION_MAX_BYTES = 1_048_576;
export const SCHEDULE_REVIEW_PROJECTION_MAX_ENTRIES = 2_000;
export const SCHEDULE_REVIEW_PROJECTION_MAX_SPEAKERS = 50;

const trimmedName = (max: number) => z.string().trim().min(1).max(max);

export const scheduleReviewProjectionSchema = z
  .object({
    schemaVersion: z.literal(SCHEDULE_REVIEW_PROJECTION_SCHEMA_VERSION),
    event: z
      .object({
        name: trimmedName(160),
        timezone: timezoneSchema,
      })
      .strict(),
    entries: z
      .array(
        z
          .object({
            startsAt: z.number().int().positive(),
            endsAt: z.number().int().positive(),
            title: trimmedName(240),
            format: trimmedName(80),
            room: trimmedName(120),
            track: trimmedName(120).nullable(),
            speakers: z
              .array(trimmedName(120))
              .max(SCHEDULE_REVIEW_PROJECTION_MAX_SPEAKERS),
          })
          .strict()
          .refine((entry) => entry.endsAt > entry.startsAt, {
            message: "A review snapshot entry must end after it starts.",
            path: ["endsAt"],
          }),
      )
      .max(SCHEDULE_REVIEW_PROJECTION_MAX_ENTRIES),
  })
  .strict();

export type ScheduleReviewProjection = z.infer<
  typeof scheduleReviewProjectionSchema
>;

export type ScheduleReviewProjectionEntryInput = {
  id: string;
  startsAt: number;
  endsAt: number;
  title: string;
  formatLabel: string;
  roomName: string;
  trackName: string | null;
  speakers: string[];
};

export class ScheduleReviewProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleReviewProjectionError";
  }
}

function normalizedProjection(value: ScheduleReviewProjection) {
  return {
    schemaVersion: SCHEDULE_REVIEW_PROJECTION_SCHEMA_VERSION,
    event: {
      name: value.event.name,
      timezone: value.event.timezone,
    },
    entries: value.entries.map((entry) => ({
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      title: entry.title,
      format: entry.format,
      room: entry.room,
      track: entry.track,
      speakers: [...entry.speakers],
    })),
  } satisfies ScheduleReviewProjection;
}

export function serializeScheduleReviewProjection(
  value: ScheduleReviewProjection,
) {
  const parsed = scheduleReviewProjectionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ScheduleReviewProjectionError(
      parsed.error.issues[0]?.message ??
        "The draft review snapshot is invalid.",
    );
  }
  const serialized = JSON.stringify(normalizedProjection(parsed.data));
  if (
    new TextEncoder().encode(serialized).byteLength >
    SCHEDULE_REVIEW_PROJECTION_MAX_BYTES
  ) {
    throw new ScheduleReviewProjectionError(
      "The draft review snapshot is larger than 1 MiB and cannot be stored.",
    );
  }
  return serialized;
}

export function parseScheduleReviewProjection(value: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new ScheduleReviewProjectionError(
      "The stored draft review snapshot is not valid JSON.",
    );
  }
  const parsed = scheduleReviewProjectionSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ScheduleReviewProjectionError(
      parsed.error.issues[0]?.message ??
        "The stored draft review snapshot does not match schema version 1.",
    );
  }
  const normalized = normalizedProjection(parsed.data);
  const serialized = JSON.stringify(normalized);
  if (
    new TextEncoder().encode(serialized).byteLength >
    SCHEDULE_REVIEW_PROJECTION_MAX_BYTES
  ) {
    throw new ScheduleReviewProjectionError(
      "The stored draft review snapshot is larger than 1 MiB.",
    );
  }
  return normalized;
}

export function buildScheduleReviewProjection(input: {
  eventName: string;
  timezone: string;
  entries: ReadonlyArray<ScheduleReviewProjectionEntryInput>;
}): ScheduleReviewProjection {
  const sorted = [...input.entries].sort(
    (left, right) =>
      left.startsAt - right.startsAt ||
      left.roomName.localeCompare(right.roomName) ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id),
  );
  return scheduleReviewProjectionSchema.parse({
    schemaVersion: SCHEDULE_REVIEW_PROJECTION_SCHEMA_VERSION,
    event: {
      name: input.eventName,
      timezone: input.timezone,
    },
    entries: sorted.map((entry) => ({
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      title: entry.title,
      format: entry.formatLabel,
      room: entry.roomName,
      track: entry.trackName,
      speakers: entry.speakers,
    })),
  });
}
