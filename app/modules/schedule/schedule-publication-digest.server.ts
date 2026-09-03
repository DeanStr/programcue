import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import type { SchedulePublicationPreview } from "./schedule-publication-preview.server";

export const SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT = 20;

const changeSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string(),
});
const moveSchema = changeSchema.extend({
  from: z.object({
    room: z.string(),
    startsAt: z.number().int(),
    endsAt: z.number().int(),
  }),
  to: z.object({
    room: z.string(),
    startsAt: z.number().int(),
    endsAt: z.number().int(),
  }),
});
const visibilitySchema = changeSchema.extend({
  from: z.string(),
  to: z.string(),
});
const contentSchema = changeSchema.extend({
  fields: z.array(
    z.enum(["title", "description", "track", "format", "duration"]),
  ),
});

export const schedulePublicationDigestSchema = z.object({
  counts: z.object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    moved: z.number().int().nonnegative(),
    visibility: z.number().int().nonnegative(),
    content: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  highlights: z.object({
    added: z
      .array(changeSchema)
      .max(SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT),
    removed: z
      .array(changeSchema)
      .max(SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT),
    moved: z.array(moveSchema).max(SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT),
    visibility: z
      .array(visibilitySchema)
      .max(SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT),
    content: z
      .array(contentSchema)
      .max(SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT),
  }),
});

export type SchedulePublicationDigest = z.infer<
  typeof schedulePublicationDigestSchema
>;

export type StoredSchedulePublicationDigest = {
  scheduleVersionId: string;
  versionNumber: number;
  previousVersionNumber: number | null;
  publishedAt: number;
  digest: SchedulePublicationDigest;
};

export function buildSchedulePublicationDigest(
  changes: SchedulePublicationPreview["changes"],
): SchedulePublicationDigest {
  const counts = {
    added: changes.added.length,
    removed: changes.removed.length,
    moved: changes.moved.length,
    visibility: changes.visibility.length,
    content: changes.content.length,
    total:
      changes.added.length +
      changes.removed.length +
      changes.moved.length +
      changes.visibility.length +
      changes.content.length,
  };
  return schedulePublicationDigestSchema.parse({
    counts,
    highlights: {
      added: changes.added.slice(
        0,
        SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT,
      ),
      removed: changes.removed.slice(
        0,
        SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT,
      ),
      moved: changes.moved.slice(
        0,
        SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT,
      ),
      visibility: changes.visibility.slice(
        0,
        SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT,
      ),
      content: changes.content
        .slice(0, SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT)
        .map((change) => ({
          sessionId: change.sessionId,
          title: change.title,
          fields: change.fields.map((field) => field.field),
        })),
    },
  });
}

export async function loadLatestSchedulePublicationDigest(
  env: CloudflareEnvironment,
  viewer: Pick<Viewer, "organisationId" | "eventId">,
): Promise<StoredSchedulePublicationDigest | null> {
  const row = await env.DB.prepare(
    `SELECT digest.schedule_version_id AS scheduleVersionId,
            version.version_number AS versionNumber,
            digest.previous_version_number AS previousVersionNumber,
            version.published_at AS publishedAt,
            digest.digest_json AS digestJson
       FROM schedule_publication_digests digest
       JOIN schedule_versions version
         ON version.id = digest.schedule_version_id
        AND version.event_id = digest.event_id
       JOIN events event
         ON event.id = digest.event_id AND event.organisation_id = ?
      WHERE digest.event_id = ? AND version.status = 'published'
      ORDER BY version.version_number DESC
      LIMIT 1`,
  )
    .bind(viewer.organisationId, viewer.eventId)
    .first<{
      scheduleVersionId: string;
      versionNumber: number;
      previousVersionNumber: number | null;
      publishedAt: number;
      digestJson: string;
    }>();
  if (!row) return null;
  return {
    scheduleVersionId: row.scheduleVersionId,
    versionNumber: row.versionNumber,
    previousVersionNumber: row.previousVersionNumber,
    publishedAt: row.publishedAt,
    digest: schedulePublicationDigestSchema.parse(JSON.parse(row.digestJson)),
  };
}
