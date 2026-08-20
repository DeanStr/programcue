import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";

export const SESSION_DETAILS_REVIEW_PRESET = "session_details_review_v1";
export const SESSION_DETAILS_REVIEW_TEMPLATE_INTENT =
  "preset:session-details-review:v1";

export const sessionDetailsReviewFieldsSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  format: z.string(),
  durationMinutes: z.number().int().positive(),
  trackId: z.string().nullable(),
  trackName: z.string().nullable(),
});

export const sessionDetailsReviewEvidenceSchema = z.object({
  version: z.literal(1),
  sessionRevision: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  fields: sessionDetailsReviewFieldsSchema,
  reviewedAt: z.number().int().positive(),
});

export type SessionDetailsReviewFields = z.infer<
  typeof sessionDetailsReviewFieldsSchema
>;

export async function sessionDetailsFingerprint(
  fields: SessionDetailsReviewFields,
) {
  const canonical = JSON.stringify([
    fields.title,
    fields.description,
    fields.format,
    fields.durationMinutes,
    fields.trackId,
    fields.trackName,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function loadParticipantSessionDetailsReview(
  env: CloudflareEnvironment,
  viewer: Viewer,
  sessionId: string,
) {
  const row = await env.DB.prepare(
    `SELECT session.title, session.description, session.format,
            session.duration_minutes AS durationMinutes,
            session.revision AS sessionRevision,
            track.id AS trackId, track.name AS trackName
       FROM session_speakers relationship
       JOIN sessions session
         ON session.id = relationship.session_id
        AND session.event_id = relationship.event_id
       JOIN events event
         ON event.id = relationship.event_id AND event.organisation_id = ?
       LEFT JOIN tracks track
         ON track.id = session.track_id AND track.event_id = session.event_id
      WHERE relationship.event_id = ? AND relationship.session_id = ?
        AND relationship.person_id = ?
        AND relationship.participation_status IN ('pending','confirmed')
        AND session.status NOT IN ('cancelled','archived')`,
  )
    .bind(viewer.organisationId, viewer.eventId, sessionId, viewer.personId)
    .first<SessionDetailsReviewFields & { sessionRevision: number }>();
  if (!row) return null;
  const parsed = sessionDetailsReviewFieldsSchema.parse(row);
  return {
    fields: parsed,
    sessionRevision: row.sessionRevision,
    fingerprint: await sessionDetailsFingerprint(parsed),
  };
}
