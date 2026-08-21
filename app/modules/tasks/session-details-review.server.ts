import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";

export const SESSION_DETAILS_REVIEW_PRESET = "session_details_review_v1";
export const SESSION_DETAILS_REVIEW_TEMPLATE_INTENT =
  "preset:session-details-review:v1";

export function canonicalSessionDetailsReviewTaskSql(alias: string) {
  return `(
    ${alias}.target_type = 'session'
    AND ${alias}.task_type = 'acknowledgement'
    AND ${alias}.impact = 'high'
    AND ${alias}.evidence_mode = 'checkbox'
    AND ${alias}.due_at IS NULL
    AND json_valid(${alias}.configuration_json)
    AND json_extract(${alias}.configuration_json, '$.preset') = '${SESSION_DETAILS_REVIEW_PRESET}'
    AND (SELECT COUNT(*) FROM json_each(${alias}.configuration_json)) = 1
    AND (
      SELECT COUNT(*) FROM task_templates event_review_template
       WHERE event_review_template.event_id = ${alias}.event_id
         AND json_extract(event_review_template.configuration_json, '$.preset') = '${SESSION_DETAILS_REVIEW_PRESET}'
    ) = 1
    AND NOT EXISTS (
      SELECT 1 FROM task_instance_dependencies review_dependency
       WHERE review_dependency.task_id = ${alias}.id
    )
    AND EXISTS (
      SELECT 1 FROM task_templates review_template
       WHERE review_template.id = ${alias}.template_id
         AND review_template.event_id = ${alias}.event_id
         AND review_template.status = 'active'
         AND review_template.target_type = 'session'
         AND review_template.task_type = 'acknowledgement'
         AND review_template.impact = 'high'
         AND review_template.evidence_mode = 'checkbox'
         AND review_template.due_anchor = 'none'
         AND review_template.due_offset_minutes IS NULL
         AND review_template.fixed_due_at IS NULL
         AND review_template.auto_assign_on_acceptance = 1
         AND json_valid(review_template.configuration_json)
         AND json_extract(review_template.configuration_json, '$.preset') = '${SESSION_DETAILS_REVIEW_PRESET}'
         AND (SELECT COUNT(*) FROM json_each(review_template.configuration_json)) = 1
         AND NOT EXISTS (
           SELECT 1 FROM task_template_dependencies template_dependency
            WHERE template_dependency.template_id = review_template.id
         )
    )
  )`;
}

export async function isCanonicalSessionDetailsReviewTask(
  env: CloudflareEnvironment,
  eventId: string,
  taskId: string,
) {
  const row = await env.DB.prepare(
    `SELECT CASE WHEN ${canonicalSessionDetailsReviewTaskSql("review_task")}
                 THEN 1 ELSE 0 END AS canonical
       FROM task_instances review_task
      WHERE review_task.id = ? AND review_task.event_id = ?`,
  )
    .bind(taskId, eventId)
    .first<{ canonical: number }>();
  return row?.canonical === 1;
}

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
