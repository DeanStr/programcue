import { data } from "react-router";

import type { Route } from "./+types/demo-reset-submissions";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

const DEMO_FORM_SLUG = "form";

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  if (String(env.DEMO_MODE) !== "true") throw new Response("Demo reset is disabled", { status: 404 });
  const formData = await request.formData();
  if (formData.get("confirm") !== "reset-submissions-demo") {
    throw new Response("Explicit demo reset confirmation is required", { status: 400 });
  }

  const form = await env.DB.prepare(`
    SELECT id FROM form_definitions WHERE event_id = ? AND public_slug = ?
  `).bind(env.DEFAULT_EVENT_ID, DEMO_FORM_SLUG).first<{ id: string }>();
  if (form) {
    const activeOperations = await env.DB.prepare(`
      WITH
        target_submissions AS (
          SELECT s.id
            FROM submissions s
            JOIN form_versions fv ON fv.id = s.form_version_id AND fv.event_id = s.event_id
           WHERE fv.form_id = ? AND s.event_id = ?
        ),
        target_decisions AS (
          SELECT d.id
            FROM submission_decisions d
           WHERE d.event_id = ? AND d.submission_id IN (SELECT id FROM target_submissions)
        )
      SELECT COUNT(*) AS activeOperationCount
        FROM operation_jobs o
       WHERE o.event_id = ?
         AND o.status IN ('queued','received','running','retrying')
         AND (
           o.idempotency_key IN (
             SELECT 'submission-confirmation:' || id FROM target_submissions
           )
           OR (
             o.type = 'submission.notification'
             AND json_extract(o.payload_json, '$.submissionId') IN (SELECT id FROM target_submissions)
           )
           OR (
             o.type = 'decision.notification'
             AND json_extract(o.payload_json, '$.payload.decisionId') IN (SELECT id FROM target_decisions)
           )
           OR (
             o.type = 'submission.notification'
             AND o.idempotency_key LIKE 'submission-confirmation:%'
             AND json_extract(o.payload_json, '$.submissionId') IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM submissions s
                WHERE s.event_id = o.event_id
                  AND s.id = json_extract(o.payload_json, '$.submissionId')
             )
           )
         )
    `).bind(
      form.id,
      env.DEFAULT_EVENT_ID,
      env.DEFAULT_EVENT_ID,
      env.DEFAULT_EVENT_ID,
    ).first<{ activeOperationCount: number }>();
    if (Number(activeOperations?.activeOperationCount ?? 0) > 0) {
      return data({
        ok: false,
        code: "ACTIVE_SUBMISSION_OPERATIONS",
        activeOperationCount: Number(activeOperations?.activeOperationCount ?? 0),
        message: "The demo reset is waiting for submission operations to reach a terminal state.",
      }, {
        status: 409,
        headers: { "Retry-After": "1" },
      });
    }
    await env.DB.batch([
      env.DB.prepare(`
        WITH
          target_submissions AS (
            SELECT s.id
              FROM submissions s
              JOIN form_versions fv ON fv.id = s.form_version_id AND fv.event_id = s.event_id
             WHERE fv.form_id = ? AND s.event_id = ?
          ),
          target_decisions AS (
            SELECT d.id
              FROM submission_decisions d
             WHERE d.event_id = ? AND d.submission_id IN (SELECT id FROM target_submissions)
          ),
          target_assignments AS (
            SELECT a.id
              FROM evaluator_assignments a
             WHERE a.event_id = ? AND a.submission_id IN (SELECT id FROM target_submissions)
          ),
          target_reviews AS (
            SELECT r.id
              FROM reviews r
             WHERE r.event_id = ? AND r.assignment_id IN (SELECT id FROM target_assignments)
          ),
          target_sessions AS (
            SELECT s.id
              FROM sessions s
             WHERE s.event_id = ? AND s.source_submission_id IN (SELECT id FROM target_submissions)
            UNION
            SELECT s.id
              FROM sessions s
              JOIN session_speakers ss ON ss.session_id = s.id AND ss.event_id = s.event_id
              JOIN people p ON p.id = ss.person_id
             WHERE s.event_id = ?
               AND s.title LIKE 'Sponsor briefing %'
               AND p.email LIKE 'sponsor-%@example.com'
          ),
          target_communications AS (
            SELECT c.id
              FROM communications c
             WHERE c.event_id = ? AND (
               c.idempotency_key IN (
                 SELECT 'submission-confirmation:' || id FROM target_submissions
               )
               OR json_extract(c.audience_json, '$.submissionId') IN (SELECT id FROM target_submissions)
               OR (
                 json_extract(c.content_snapshot_json, '$.category') = 'submission_confirmation'
                 AND json_extract(c.content_snapshot_json, '$.submissionId') IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM submissions s
                    WHERE s.event_id = c.event_id
                      AND s.id = json_extract(c.content_snapshot_json, '$.submissionId')
                 )
               )
             )
          ),
          target_operations AS (
            SELECT o.id, o.correlation_id
              FROM operation_jobs o
             WHERE o.event_id = ? AND (
               o.idempotency_key IN (
                 SELECT 'submission-confirmation:' || id FROM target_submissions
               )
               OR (
                 o.type = 'submission.notification'
                 AND json_extract(o.payload_json, '$.submissionId') IN (SELECT id FROM target_submissions)
               )
               OR (
                 o.type = 'decision.notification'
                 AND json_extract(o.payload_json, '$.payload.decisionId') IN (SELECT id FROM target_decisions)
               )
               OR (
                 o.type = 'submission.notification'
                 AND o.idempotency_key LIKE 'submission-confirmation:%'
                 AND json_extract(o.payload_json, '$.submissionId') IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM submissions s
                    WHERE s.event_id = o.event_id
                      AND s.id = json_extract(o.payload_json, '$.submissionId')
                 )
               )
             )
          )
        DELETE FROM event_changes
         WHERE event_id = ? AND (
           (entity_type = 'form_definition' AND entity_id = ?)
           OR (entity_type = 'form_version' AND entity_id IN (
             SELECT id FROM form_versions WHERE form_id = ? AND event_id = ?
           ))
           OR (entity_type = 'submission' AND entity_id IN (SELECT id FROM target_submissions))
           OR (entity_type = 'submission_decision' AND entity_id IN (SELECT id FROM target_decisions))
           OR (entity_type = 'evaluator_assignment' AND entity_id IN (SELECT id FROM target_assignments))
           OR (entity_type = 'review' AND entity_id IN (SELECT id FROM target_reviews))
           OR (entity_type = 'session' AND entity_id IN (SELECT id FROM target_sessions))
           OR (entity_type = 'communication' AND entity_id IN (SELECT id FROM target_communications))
           OR (entity_type = 'submission' AND entity_id IN (
             SELECT json_extract(payload_json, '$.submissionId')
               FROM operation_jobs
              WHERE event_id = ?
                AND type = 'submission.notification'
                AND idempotency_key LIKE 'submission-confirmation:%'
                AND json_extract(payload_json, '$.submissionId') IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM submissions s
                   WHERE s.event_id = operation_jobs.event_id
                     AND s.id = json_extract(operation_jobs.payload_json, '$.submissionId')
                )
           ))
           OR entity_id IN (SELECT id FROM target_operations)
           OR correlation_id IN (SELECT correlation_id FROM target_operations)
         )
      `).bind(
        form.id,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
        form.id,
        form.id,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
      ),
      env.DB.prepare(`
        DELETE FROM operation_jobs
         WHERE event_id = ? AND (
           idempotency_key IN (
             SELECT 'submission-confirmation:' || s.id
               FROM submissions s
               JOIN form_versions fv ON fv.id = s.form_version_id AND fv.event_id = s.event_id
              WHERE fv.form_id = ? AND s.event_id = ?
           )
           OR (
             type = 'submission.notification'
             AND json_extract(payload_json, '$.submissionId') IN (
               SELECT s.id
                 FROM submissions s
                 JOIN form_versions fv ON fv.id = s.form_version_id AND fv.event_id = s.event_id
                WHERE fv.form_id = ? AND s.event_id = ?
             )
           )
           OR (
             type = 'decision.notification'
             AND json_extract(payload_json, '$.payload.decisionId') IN (
               SELECT d.id
                 FROM submission_decisions d
                 JOIN submissions s ON s.id = d.submission_id AND s.event_id = d.event_id
                 JOIN form_versions fv ON fv.id = s.form_version_id AND fv.event_id = s.event_id
               WHERE fv.form_id = ? AND d.event_id = ?
             )
           )
           OR (
             type = 'submission.notification'
             AND idempotency_key LIKE 'submission-confirmation:%'
             AND json_extract(payload_json, '$.submissionId') IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM submissions s
                WHERE s.event_id = operation_jobs.event_id
                  AND s.id = json_extract(operation_jobs.payload_json, '$.submissionId')
             )
           )
         )
      `).bind(
        env.DEFAULT_EVENT_ID,
        form.id,
        env.DEFAULT_EVENT_ID,
        form.id,
        env.DEFAULT_EVENT_ID,
        form.id,
        env.DEFAULT_EVENT_ID,
      ),
      env.DB.prepare(`
        DELETE FROM communications
         WHERE event_id = ? AND (
           idempotency_key IN (
             SELECT 'submission-confirmation:' || s.id
               FROM submissions s
               JOIN form_versions fv ON fv.id = s.form_version_id AND fv.event_id = s.event_id
              WHERE fv.form_id = ? AND s.event_id = ?
           )
           OR json_extract(audience_json, '$.submissionId') IN (
             SELECT s.id
               FROM submissions s
               JOIN form_versions fv ON fv.id = s.form_version_id AND fv.event_id = s.event_id
              WHERE fv.form_id = ? AND s.event_id = ?
           )
           OR (
             json_extract(content_snapshot_json, '$.category') = 'submission_confirmation'
             AND json_extract(content_snapshot_json, '$.submissionId') IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM submissions s
                WHERE s.event_id = communications.event_id
                  AND s.id = json_extract(communications.content_snapshot_json, '$.submissionId')
             )
           )
         )
      `).bind(
        env.DEFAULT_EVENT_ID,
        form.id,
        env.DEFAULT_EVENT_ID,
        form.id,
        env.DEFAULT_EVENT_ID,
      ),
      env.DB.prepare("DELETE FROM verification_tokens WHERE substr(identifier, 1, length(?)) = ?")
        .bind(`application-session:${form.id}:`, `application-session:${form.id}:`),
      env.DB.prepare(`
        DELETE FROM sessions
         WHERE event_id = ? AND source_submission_id IN (
           SELECT s.id
             FROM submissions s
             JOIN form_versions fv ON fv.id = s.form_version_id AND fv.event_id = s.event_id
            WHERE fv.form_id = ? AND s.event_id = ?
         )
      `).bind(env.DEFAULT_EVENT_ID, form.id, env.DEFAULT_EVENT_ID),
      env.DB.prepare(`
        DELETE FROM submissions
         WHERE event_id = ?
           AND form_version_id IN (SELECT id FROM form_versions WHERE form_id = ? AND event_id = ?)
      `).bind(env.DEFAULT_EVENT_ID, form.id, env.DEFAULT_EVENT_ID),
      env.DB.prepare("DELETE FROM form_definitions WHERE id = ? AND event_id = ?").bind(form.id, env.DEFAULT_EVENT_ID),
    ]);
  }
  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM sessions
       WHERE event_id = ?
         AND title LIKE 'Sponsor briefing %'
         AND EXISTS (
           SELECT 1
             FROM session_speakers ss
             JOIN people p ON p.id = ss.person_id
            WHERE ss.session_id = sessions.id
              AND ss.event_id = sessions.event_id
              AND p.email LIKE 'sponsor-%@example.com'
         )
    `).bind(env.DEFAULT_EVENT_ID),
    env.DB.prepare("DELETE FROM submission_email_verifications WHERE event_id = ? AND instr(email, 'browser-') = 1").bind(env.DEFAULT_EVENT_ID),
  ]);

  await ensureDemoSubmissionForm(env);
  const baseline = await env.DB.prepare(`
    SELECT f.id,
           COUNT(DISTINCT fv.id) AS versionCount,
           COUNT(DISTINCT CASE WHEN fv.status = 'published' THEN fv.id END) AS publishedVersionCount,
           COUNT(DISTINCT CASE WHEN fv.status = 'draft' THEN fv.id END) AS draftVersionCount,
           COUNT(DISTINCT s.id) AS submissionCount,
           (
             SELECT COUNT(*) FROM operation_jobs o
              WHERE o.event_id = f.event_id
                AND o.type = 'submission.notification'
                AND o.idempotency_key LIKE 'submission-confirmation:%'
                AND json_extract(o.payload_json, '$.submissionId') IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM submissions candidate
                   WHERE candidate.event_id = o.event_id
                     AND candidate.id = json_extract(o.payload_json, '$.submissionId')
                )
           ) AS orphanConfirmationOperationCount
      FROM form_definitions f
      LEFT JOIN form_versions fv ON fv.form_id = f.id AND fv.event_id = f.event_id
      LEFT JOIN submissions s ON s.form_version_id = fv.id AND s.event_id = f.event_id
     WHERE f.event_id = ? AND f.public_slug = ? AND f.status = 'published'
     GROUP BY f.id
  `).bind(env.DEFAULT_EVENT_ID, DEMO_FORM_SLUG).first<{
    id: string;
    versionCount: number;
    publishedVersionCount: number;
    draftVersionCount: number;
    submissionCount: number;
    orphanConfirmationOperationCount: number;
  }>();
  if (!baseline
    || Number(baseline.versionCount) !== 2
    || Number(baseline.publishedVersionCount) !== 1
    || Number(baseline.draftVersionCount) !== 1
    || Number(baseline.submissionCount) !== 0
    || Number(baseline.orphanConfirmationOperationCount) !== 0) {
    throw new Response("The deterministic demo form baseline could not be restored", { status: 500 });
  }
  return data({
    ok: true,
    baseline: {
      versionCount: Number(baseline.versionCount),
      publishedVersionCount: Number(baseline.publishedVersionCount),
      draftVersionCount: Number(baseline.draftVersionCount),
      submissionCount: Number(baseline.submissionCount),
    },
  });
}
