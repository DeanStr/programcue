import { data } from "react-router";

import type { Route } from "./+types/demo-reset-submissions";
import { requireEmailProviderConfiguration } from "~/modules/communications/email-provider.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { DEMO_EVENT_ID } from "~/platform/demo/demo-identities";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";

const DEMO_FORM_SLUG = "form";
const VERIFIED_LOCAL_SENDER_FIXTURE = "verified_local_capture";
const VERIFIED_LOCAL_SENDER_ID = "sender-demo-submissions-e2e";

function assertCanonicalDemoRuntime(env: CloudflareEnvironment) {
  const mode = requireRuntimeMode(env);
  if (
    !mode.demo ||
    String(env.DEMO_MODE) !== "true" ||
    env.DEFAULT_EVENT_ID !== DEMO_EVENT_ID
  ) {
    throw new Response("Demo reset is disabled", { status: 404 });
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  assertCanonicalDemoRuntime(env);
  const formData = await request.formData();
  if (formData.get("confirm") !== "reset-submissions-demo") {
    throw new Response("Explicit demo reset confirmation is required", {
      status: 400,
    });
  }
  const requestedSenderFixture = String(
    formData.get("senderFixture") ?? "",
  ).trim();
  if (
    requestedSenderFixture &&
    requestedSenderFixture !== VERIFIED_LOCAL_SENDER_FIXTURE
  ) {
    throw new Response("Unsupported demo submission sender fixture", {
      status: 400,
    });
  }
  const configureVerifiedLocalSender =
    requestedSenderFixture === VERIFIED_LOCAL_SENDER_FIXTURE;
  const localSenderProvider = configureVerifiedLocalSender
    ? requireEmailProviderConfiguration(env)
    : null;
  if (localSenderProvider && localSenderProvider.provider !== "mailpit") {
    throw new Response(
      "The verified local-capture sender fixture requires EMAIL_PROVIDER=mailpit.",
      { status: 409 },
    );
  }

  await ensureDemoSubmissionForm(env);
  const form = await env.DB.prepare(
    `
    SELECT id FROM form_definitions WHERE event_id = ? AND public_slug = ?
  `,
  )
    .bind(env.DEFAULT_EVENT_ID, DEMO_FORM_SLUG)
    .first<{ id: string }>();
  if (!form) {
    throw new Error("The deterministic demo submission form is unavailable.");
  }
  if (form) {
    const activeOperations = await env.DB.prepare(
      `
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
        target_communications AS (
          SELECT c.id, c.operation_id
            FROM communications c
           WHERE c.event_id = ?
             AND json_extract(c.audience_json, '$.submissionId') IN (
               SELECT id FROM target_submissions
             )
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
             o.type = 'communication.send'
             AND EXISTS (
               SELECT 1
                 FROM target_communications communication
                WHERE communication.operation_id = o.id
                  AND communication.id = json_extract(o.payload_json, '$.communicationId')
             )
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
    `,
    )
      .bind(
        form.id,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
      )
      .first<{ activeOperationCount: number }>();
    if (!activeOperations) {
      throw new Error(
        "The active demo submission operation count is unavailable.",
      );
    }
    const activeOperationCount = activeOperations.activeOperationCount;
    if (
      typeof activeOperationCount !== "number" ||
      !Number.isSafeInteger(activeOperationCount) ||
      activeOperationCount < 0
    ) {
      throw new Error("The active demo submission operation count is invalid.");
    }
    if (activeOperationCount > 0) {
      return data(
        {
          ok: false,
          code: "ACTIVE_SUBMISSION_OPERATIONS",
          activeOperationCount,
          message:
            "The demo reset is waiting for submission operations to reach a terminal state.",
        },
        {
          status: 409,
          headers: { "Retry-After": "1" },
        },
      );
    }
    await env.DB.batch([
      env.DB.prepare(
        `WITH target_sessions AS (
           SELECT session.id
             FROM sessions session
             JOIN session_speakers speaker
               ON speaker.session_id = session.id
              AND speaker.event_id = session.event_id
             JOIN people person ON person.id = speaker.person_id
            WHERE session.event_id = ?
              AND session.source_submission_id IS NULL
              AND session.title LIKE 'Sponsor briefing %'
              AND person.email LIKE 'sponsor-%@example.com'
         ), target_speakers AS (
           SELECT DISTINCT speaker.person_id
             FROM session_speakers speaker
            WHERE speaker.event_id = ?
              AND speaker.session_id IN (SELECT id FROM target_sessions)
              AND NOT EXISTS (
                SELECT 1 FROM session_speakers retained
                 WHERE retained.event_id = speaker.event_id
                   AND retained.person_id = speaker.person_id
                   AND retained.session_id NOT IN (SELECT id FROM target_sessions)
              )
         )
         DELETE FROM memberships
          WHERE event_id = ? AND role = 'speaker'
            AND person_id IN (SELECT person_id FROM target_speakers)
            AND EXISTS (
              SELECT 1 FROM idempotency_records command
               WHERE command.id = memberships.last_operation_id
                 AND command.event_id = memberships.event_id
                 AND command.scope = 'submission.admin.direct_session.create'
                 AND command.status = 'completed'
                 AND command.entity_type = 'session'
                 AND command.entity_id IN (SELECT id FROM target_sessions)
            )`,
      ).bind(env.DEFAULT_EVENT_ID, env.DEFAULT_EVENT_ID, env.DEFAULT_EVENT_ID),
      env.DB.prepare(
        `
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
               AND s.source_submission_id IS NULL
               AND s.title LIKE 'Sponsor briefing %'
               AND p.email LIKE 'sponsor-%@example.com'
          ),
          target_direct_sessions AS (
            SELECT target.id
              FROM target_sessions target
              JOIN sessions session ON session.id = target.id
             WHERE session.source_submission_id IS NULL
               AND session.title LIKE 'Sponsor briefing %'
               AND EXISTS (
                 SELECT 1
                   FROM session_speakers speaker
                   JOIN people person ON person.id = speaker.person_id
                  WHERE speaker.session_id = session.id
                    AND speaker.event_id = session.event_id
                    AND person.email LIKE 'sponsor-%@example.com'
               )
          ),
          disposable_direct_speakers AS (
            SELECT DISTINCT speaker.person_id
              FROM session_speakers speaker
             WHERE speaker.event_id = ?
               AND speaker.session_id IN (SELECT id FROM target_direct_sessions)
               AND NOT EXISTS (
                 SELECT 1
                   FROM session_speakers retained
                  WHERE retained.event_id = speaker.event_id
                    AND retained.person_id = speaker.person_id
                    AND retained.session_id NOT IN (SELECT id FROM target_sessions)
               )
               AND NOT EXISTS (
                 SELECT 1
                   FROM memberships membership
                  WHERE membership.event_id = speaker.event_id
                    AND membership.person_id = speaker.person_id
                    AND membership.role = 'speaker'
                    AND membership.accepted_at IS NOT NULL
                    AND membership.revoked_at IS NULL
               )
          ),
          target_acknowledgement_tasks AS (
            SELECT task.id
              FROM task_instances task
             WHERE task.event_id = ?
               AND task.target_type = 'speaker'
               AND task.target_id IN (SELECT person_id FROM disposable_direct_speakers)
               AND task.task_type = 'acknowledgement'
               AND task.id = task.template_id || ':' || task.target_id
               AND EXISTS (
                 SELECT 1
                   FROM task_templates template
                  WHERE template.id = task.template_id
                    AND template.event_id = task.event_id
                    AND template.target_type = 'speaker'
                    AND template.task_type = 'acknowledgement'
                    AND template.id = 'resource-ack:' || json_extract(
                      template.configuration_json,
                      '$.resourcePageId'
                    )
               )
          ),
          target_communications AS (
            SELECT c.id, c.operation_id
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
                 o.type = 'communication.send'
                 AND EXISTS (
                   SELECT 1
                     FROM target_communications communication
                    WHERE communication.operation_id = o.id
                      AND communication.id = json_extract(o.payload_json, '$.communicationId')
                 )
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
           OR (
             entity_type IN ('task', 'task_instance')
             AND entity_id IN (SELECT id FROM target_acknowledgement_tasks)
           )
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
      `,
      ).bind(
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
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
        form.id,
        form.id,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
      ),
      env.DB.prepare(
        `
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
             type = 'communication.send'
             AND EXISTS (
               SELECT 1
                 FROM communications communication
                WHERE communication.event_id = operation_jobs.event_id
                  AND communication.operation_id = operation_jobs.id
                  AND communication.id = json_extract(operation_jobs.payload_json, '$.communicationId')
                  AND json_extract(communication.audience_json, '$.submissionId') IN (
                    SELECT submission.id
                      FROM submissions submission
                      JOIN form_versions version
                        ON version.id = submission.form_version_id
                       AND version.event_id = submission.event_id
                     WHERE version.form_id = ?
                       AND submission.event_id = ?
                  )
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
      `,
      ).bind(
        env.DEFAULT_EVENT_ID,
        form.id,
        env.DEFAULT_EVENT_ID,
        form.id,
        env.DEFAULT_EVENT_ID,
        form.id,
        env.DEFAULT_EVENT_ID,
        form.id,
        env.DEFAULT_EVENT_ID,
      ),
      env.DB.prepare(
        `
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
      `,
      ).bind(
        env.DEFAULT_EVENT_ID,
        form.id,
        env.DEFAULT_EVENT_ID,
        form.id,
        env.DEFAULT_EVENT_ID,
      ),
      env.DB.prepare(
        "DELETE FROM verification_tokens WHERE substr(identifier, 1, length(?)) = ?",
      ).bind(
        `application-session:${form.id}:`,
        `application-session:${form.id}:`,
      ),
      env.DB.prepare(
        `
        WITH
          target_submissions AS (
            SELECT submission.id
              FROM submissions submission
              JOIN form_versions version
                ON version.id = submission.form_version_id
               AND version.event_id = submission.event_id
             WHERE version.form_id = ? AND submission.event_id = ?
          ),
          target_sessions AS (
            SELECT session.id
              FROM sessions session
             WHERE session.event_id = ?
               AND session.source_submission_id IN (SELECT id FROM target_submissions)
            UNION
            SELECT session.id
              FROM sessions session
              JOIN session_speakers speaker
                ON speaker.session_id = session.id
               AND speaker.event_id = session.event_id
              JOIN people person ON person.id = speaker.person_id
             WHERE session.event_id = ?
               AND session.source_submission_id IS NULL
               AND session.title LIKE 'Sponsor briefing %'
               AND person.email LIKE 'sponsor-%@example.com'
          ),
          target_direct_sessions AS (
            SELECT target.id
              FROM target_sessions target
              JOIN sessions session ON session.id = target.id
             WHERE session.source_submission_id IS NULL
               AND session.title LIKE 'Sponsor briefing %'
               AND EXISTS (
                 SELECT 1
                   FROM session_speakers speaker
                   JOIN people person ON person.id = speaker.person_id
                  WHERE speaker.session_id = session.id
                    AND speaker.event_id = session.event_id
                    AND person.email LIKE 'sponsor-%@example.com'
               )
          ),
          disposable_direct_speakers AS (
            SELECT DISTINCT speaker.person_id
              FROM session_speakers speaker
             WHERE speaker.event_id = ?
               AND speaker.session_id IN (SELECT id FROM target_direct_sessions)
               AND NOT EXISTS (
                 SELECT 1
                   FROM session_speakers retained
                  WHERE retained.event_id = speaker.event_id
                    AND retained.person_id = speaker.person_id
                    AND retained.session_id NOT IN (SELECT id FROM target_sessions)
               )
               AND NOT EXISTS (
                 SELECT 1
                   FROM memberships membership
                  WHERE membership.event_id = speaker.event_id
                    AND membership.person_id = speaker.person_id
                    AND membership.role = 'speaker'
                    AND membership.accepted_at IS NOT NULL
                    AND membership.revoked_at IS NULL
               )
          )
        DELETE FROM task_instances AS task
         WHERE task.event_id = ?
           AND task.target_type = 'speaker'
           AND task.target_id IN (SELECT person_id FROM disposable_direct_speakers)
           AND task.task_type = 'acknowledgement'
           AND task.id = task.template_id || ':' || task.target_id
           AND EXISTS (
             SELECT 1
               FROM task_templates template
              WHERE template.id = task.template_id
                AND template.event_id = task.event_id
                AND template.target_type = 'speaker'
                AND template.task_type = 'acknowledgement'
                AND template.id = 'resource-ack:' || json_extract(
                  template.configuration_json,
                  '$.resourcePageId'
                )
           )
      `,
      ).bind(
        form.id,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
        env.DEFAULT_EVENT_ID,
      ),
      env.DB.prepare(
        `
        DELETE FROM sessions
         WHERE event_id = ? AND source_submission_id IN (
           SELECT s.id
             FROM submissions s
             JOIN form_versions fv ON fv.id = s.form_version_id AND fv.event_id = s.event_id
            WHERE fv.form_id = ? AND s.event_id = ?
         )
      `,
      ).bind(env.DEFAULT_EVENT_ID, form.id, env.DEFAULT_EVENT_ID),
      env.DB.prepare(
        `
        DELETE FROM submissions
         WHERE event_id = ?
           AND form_version_id IN (SELECT id FROM form_versions WHERE form_id = ? AND event_id = ?)
      `,
      ).bind(env.DEFAULT_EVENT_ID, form.id, env.DEFAULT_EVENT_ID),
      env.DB.prepare(
        "DELETE FROM form_definitions WHERE id = ? AND event_id = ?",
      ).bind(form.id, env.DEFAULT_EVENT_ID),
    ]);
  }
  await env.DB.batch([
    env.DB.prepare(
      `
      DELETE FROM sessions
       WHERE event_id = ?
         AND source_submission_id IS NULL
         AND title LIKE 'Sponsor briefing %'
         AND EXISTS (
           SELECT 1
             FROM session_speakers ss
             JOIN people p ON p.id = ss.person_id
            WHERE ss.session_id = sessions.id
              AND ss.event_id = sessions.event_id
              AND p.email LIKE 'sponsor-%@example.com'
         )
    `,
    ).bind(env.DEFAULT_EVENT_ID),
    env.DB.prepare(
      "DELETE FROM sender_profiles WHERE id = ? AND event_id = ?",
    ).bind(VERIFIED_LOCAL_SENDER_ID, env.DEFAULT_EVENT_ID),
    env.DB.prepare(
      "DELETE FROM submission_email_verifications WHERE event_id = ? AND instr(email, 'browser-') = 1",
    ).bind(env.DEFAULT_EVENT_ID),
  ]);

  await ensureDemoSubmissionForm(env);
  if (configureVerifiedLocalSender) {
    await env.DB.prepare(
      `
      INSERT INTO sender_profiles (
        id, event_id, name, from_name, from_email, reply_to_email,
        provider, status, created_at, updated_at
      ) VALUES (
        ?, ?, 'Submissions E2E local capture', 'Program Cue E2E',
        'submissions-e2e@example.invalid', 'submissions-e2e@example.invalid',
        ?, 'verified', unixepoch(), unixepoch()
      )
    `,
    )
      .bind(
        VERIFIED_LOCAL_SENDER_ID,
        env.DEFAULT_EVENT_ID,
        localSenderProvider?.provider,
      )
      .run();
  }
  const baseline = await env.DB.prepare(
    `
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
           ,(
             SELECT COUNT(*)
               FROM operation_jobs operation
               JOIN communications communication
                 ON communication.event_id = operation.event_id
                AND communication.operation_id = operation.id
                AND communication.id = json_extract(
                  operation.payload_json,
                  '$.communicationId'
                )
              WHERE operation.event_id = f.event_id
                AND operation.type = 'communication.send'
                AND json_extract(
                  communication.audience_json,
                  '$.type'
                ) = 'co_speaker_invitation'
                AND json_extract(
                  communication.audience_json,
                  '$.submissionId'
                ) IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1
                    FROM submissions candidate
                   WHERE candidate.event_id = operation.event_id
                     AND candidate.id = json_extract(
                       communication.audience_json,
                       '$.submissionId'
                     )
                )
           ) AS orphanCoSpeakerOperationCount
           ,(
             SELECT COUNT(*)
               FROM sender_profiles sender
              WHERE sender.id = ?
                AND sender.event_id = f.event_id
                AND sender.name = 'Submissions E2E local capture'
                AND sender.from_name = 'Program Cue E2E'
                AND sender.from_email = 'submissions-e2e@example.invalid'
                AND sender.reply_to_email = 'submissions-e2e@example.invalid'
                AND sender.provider = ?
                AND sender.status = 'verified'
           ) AS senderFixtureCount
      FROM form_definitions f
      LEFT JOIN form_versions fv ON fv.form_id = f.id AND fv.event_id = f.event_id
      LEFT JOIN submissions s ON s.form_version_id = fv.id AND s.event_id = f.event_id
     WHERE f.event_id = ? AND f.public_slug = ? AND f.status = 'published'
     GROUP BY f.id
  `,
  )
    .bind(
      VERIFIED_LOCAL_SENDER_ID,
      localSenderProvider?.provider ?? "mailpit",
      env.DEFAULT_EVENT_ID,
      DEMO_FORM_SLUG,
    )
    .first<{
      id: string;
      versionCount: number;
      publishedVersionCount: number;
      draftVersionCount: number;
      submissionCount: number;
      orphanConfirmationOperationCount: number;
      orphanCoSpeakerOperationCount: number;
      senderFixtureCount: number;
    }>();
  if (
    !baseline ||
    Number(baseline.versionCount) !== 2 ||
    Number(baseline.publishedVersionCount) !== 1 ||
    Number(baseline.draftVersionCount) !== 1 ||
    Number(baseline.submissionCount) !== 0 ||
    Number(baseline.orphanConfirmationOperationCount) !== 0 ||
    Number(baseline.orphanCoSpeakerOperationCount) !== 0 ||
    Number(baseline.senderFixtureCount) !==
      (configureVerifiedLocalSender ? 1 : 0)
  ) {
    throw new Response(
      "The deterministic demo form baseline could not be restored",
      { status: 500 },
    );
  }
  return data({
    ok: true,
    baseline: {
      versionCount: Number(baseline.versionCount),
      publishedVersionCount: Number(baseline.publishedVersionCount),
      draftVersionCount: Number(baseline.draftVersionCount),
      submissionCount: Number(baseline.submissionCount),
      senderFixtureConfigured: Boolean(Number(baseline.senderFixtureCount)),
    },
  });
}
