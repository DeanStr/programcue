import { requireValue } from "~/lib/required-value";
import type { DecisionNotificationIntent } from "~/modules/communications/decision-notification-intent.server";
import { materializePublishedResourceAcknowledgementsForSession } from "~/modules/resources/resource-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import type { AcceptedSpeakerInvitationPlan } from "./accepted-speaker-invitation.server";
import {
  decisionAuthorityBindings,
  decisionAuthorityGuardSql,
} from "./evaluation-decision-authority.server";
import type { decisionSchema } from "./evaluation-schema";

export type DecisionSubmission = {
  id: string;
  title: string;
  reference: string;
  format: string | null;
  category: string | null;
  notificationAddress: string | null;
  notificationPersonId: string | null;
  notificationName: string | null;
  eventName: string;
  eventBrandAccent: string;
  eventStartsAt: number;
  eventEndsAt: number;
  status: string;
  revision: number;
  snapshotJson: string | null;
};

export type DecisionReviewFeedbackEvidence = {
  assignmentId: string;
  assignedAt: number;
  reviewId: string;
  reviewRevision: number;
  reviewStatus: "submitted" | "locked";
  applicantFeedback: string;
};

export {
  acceptanceTaskPlanBindings,
  acceptanceTaskPlanCteSql,
  acceptanceTaskPlanGuardSql,
  buildAcceptanceTaskPlanStatements,
} from "./evaluation-acceptance-task-plan.server";

import {
  acceptanceTaskPlanGuardSql,
  buildAcceptanceTaskPlanStatements,
} from "./evaluation-acceptance-task-plan.server";

export function buildDecisionStatements(input: {
  env: CloudflareEnvironment;
  viewer: Viewer;
  parsed: ReturnType<typeof decisionSchema.parse>;
  submission: DecisionSubmission;
  revision: number;
  decisionId: string;
  status: "published" | "draft";
  submissionStatus: string;
  sessionId: string | null;
  sessionTitle: string;
  sessionDescription: string;
  slug: string;
  format: string;
  sessionDurationMinutes: number;
  sessionTrack: { id: string; name: string } | null;
  notificationIntent: DecisionNotificationIntent | null;
  notificationFeedback: string[];
  notificationFeedbackEvidence: DecisionReviewFeedbackEvidence[];
  roundId: string | null;
  planId: string | null;
  speakerMemberships: Array<{ membershipId: string; personId: string }>;
  speakerInvitationPlans: AcceptedSpeakerInvitationPlan[];
  auditEventId: string;
}) {
  const {
    env,
    viewer,
    parsed,
    submission,
    revision,
    decisionId,
    status,
    submissionStatus,
    sessionId,
    sessionTitle,
    sessionDescription,
    slug,
    format,
    sessionDurationMinutes,
    sessionTrack,
    notificationIntent,
    notificationFeedback,
    notificationFeedbackEvidence,
    roundId,
    planId,
    speakerMemberships,
    speakerInvitationPlans,
    auditEventId,
  } = input;
  const notificationOperationId = notificationIntent?.operationId ?? null;
  const notificationTemplateVersionId =
    notificationIntent?.templateVersionId ?? null;
  const notificationSenderProfileId =
    notificationIntent?.senderProfileId ?? null;
  const notificationAddress = notificationIntent?.recipientAddress ?? null;
  if (parsed.decision === "accepted" && !sessionTrack) {
    throw new Error(
      "Accepted decision statements require the confirmed submitted track.",
    );
  }
  if (parsed.decision === "accepted" && !format) {
    throw new Error(
      "Accepted decision statements require the confirmed current session format.",
    );
  }
  if (parsed.decision !== "accepted" && sessionTrack) {
    throw new Error(
      "Only accepted decision statements may carry a programme track.",
    );
  }
  if (
    status === "published" &&
    (!notificationIntent ||
      !notificationTemplateVersionId ||
      !notificationSenderProfileId ||
      !notificationAddress)
  ) {
    throw new Error(
      "Published decision statements require confirmed notification readiness.",
    );
  }
  const speakerSetGuard = speakerMemberships.length
    ? `(
        SELECT COUNT(*) FROM submission_speakers current_speaker
         WHERE current_speaker.event_id = submissions.event_id
           AND current_speaker.submission_id = submissions.id
           AND current_speaker.person_id IS NOT NULL
      ) = ?
      AND NOT EXISTS (
        SELECT 1 FROM submission_speakers current_speaker
         WHERE current_speaker.event_id = submissions.event_id
           AND current_speaker.submission_id = submissions.id
           AND (
             current_speaker.person_id IS NULL
             OR current_speaker.person_id NOT IN (${speakerMemberships.map(() => "?").join(",")})
           )
      )`
    : "0";
  const speakerSetBindings = speakerMemberships.length
    ? [
        speakerMemberships.length,
        ...speakerMemberships.map((membership) => membership.personId),
      ]
    : [];
  if (roundId && !planId) {
    throw new Error(
      "Decision statements with review evidence require exact plan provenance.",
    );
  }
  const decisionCycleGuard = roundId
    ? {
        sql: `EXISTS (
          SELECT 1
            FROM evaluator_assignments evidence_assignment
            JOIN reviews evidence_review
              ON evidence_review.assignment_id = evidence_assignment.id
             AND evidence_review.event_id = evidence_assignment.event_id
             AND evidence_review.status IN ('submitted','locked')
            JOIN evaluation_rounds evidence_round
              ON evidence_round.id = evidence_assignment.round_id
             AND evidence_round.event_id = evidence_assignment.event_id
            JOIN evaluation_plans evidence_plan
              ON evidence_plan.id = evidence_round.plan_id
             AND evidence_plan.event_id = evidence_round.event_id
           WHERE evidence_assignment.event_id = submissions.event_id
             AND evidence_assignment.submission_id = submissions.id
             AND evidence_assignment.round_id = ?
             AND evidence_plan.id = ?
             AND evidence_round.status IN ('active','closed')
             AND evidence_plan.status IN ('active','closed')
             AND (SELECT COUNT(*)
                    FROM evaluation_plans current_plan
                   WHERE current_plan.event_id = submissions.event_id
                     AND current_plan.status <> 'archived') = 1
        )`,
        bindings: [roundId, planId],
      }
    : planId
      ? {
          sql: `EXISTS (
            SELECT 1
              FROM evaluation_plans evidence_plan
             WHERE evidence_plan.id = ?
               AND evidence_plan.event_id = submissions.event_id
               AND evidence_plan.status IN ('draft','active','closed')
               AND (SELECT COUNT(*)
                      FROM evaluation_plans current_plan
                     WHERE current_plan.event_id = submissions.event_id
                       AND current_plan.status <> 'archived') = 1
          )`,
          bindings: [planId],
        }
      : {
          sql: `NOT EXISTS (
            SELECT 1
              FROM evaluation_plans current_plan
             WHERE current_plan.event_id = submissions.event_id
               AND current_plan.status <> 'archived'
          )`,
          bindings: [],
        };
  const notificationFeedbackGuardSql = parsed.includeReviewerFeedback
    ? `(
        (SELECT COUNT(*)
           FROM evaluator_assignments feedback_assignment
           JOIN reviews feedback_review
             ON feedback_review.assignment_id = feedback_assignment.id
            AND feedback_review.event_id = feedback_assignment.event_id
          WHERE feedback_assignment.event_id = submissions.event_id
            AND feedback_assignment.submission_id = submissions.id
            AND feedback_assignment.round_id = ?
            AND feedback_review.status IN ('submitted','locked')) =
          json_array_length(?)
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) feedback_snapshot
           WHERE NOT EXISTS (
              SELECT 1
                FROM evaluator_assignments exact_feedback_assignment
                JOIN reviews exact_feedback_review
                  ON exact_feedback_review.assignment_id = exact_feedback_assignment.id
                 AND exact_feedback_review.event_id = exact_feedback_assignment.event_id
               WHERE exact_feedback_assignment.id =
                     json_extract(feedback_snapshot.value, '$.assignmentId')
                 AND exact_feedback_assignment.event_id = submissions.event_id
                 AND exact_feedback_assignment.submission_id = submissions.id
                 AND exact_feedback_assignment.round_id = ?
                 AND exact_feedback_assignment.assigned_at =
                     json_extract(feedback_snapshot.value, '$.assignedAt')
                 AND exact_feedback_review.id =
                     json_extract(feedback_snapshot.value, '$.reviewId')
                 AND exact_feedback_review.revision =
                     json_extract(feedback_snapshot.value, '$.reviewRevision')
                 AND exact_feedback_review.status =
                     json_extract(feedback_snapshot.value, '$.reviewStatus')
                 AND trim(COALESCE(exact_feedback_review.submitter_feedback, '')) =
                     json_extract(feedback_snapshot.value, '$.applicantFeedback')
            )
        )
      )`
    : "1";
  const notificationFeedbackEvidenceJson = JSON.stringify(
    notificationFeedbackEvidence,
  );
  const notificationFeedbackGuardBindings = parsed.includeReviewerFeedback
    ? [
        roundId,
        notificationFeedbackEvidenceJson,
        notificationFeedbackEvidenceJson,
        roundId,
      ]
    : [];
  return [
    env.DB.prepare(
      `
        UPDATE submissions
           SET status = ?, revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND status IN ('submitted','assigned','in_review','decision_ready')
           AND (${decisionCycleGuard.sql})
           AND (${notificationFeedbackGuardSql})
           AND (
             ? <> 'published' OR ? <> 'accepted'
             OR ((${speakerSetGuard}) AND (${acceptanceTaskPlanGuardSql}))
           )
           AND (
             ? <> 'accepted'
              OR EXISTS (
                SELECT 1 FROM submission_track_selections selection
                JOIN tracks current_track
                  ON current_track.id = selection.track_id
                 AND current_track.event_id = selection.event_id
                 WHERE selection.submission_id = submissions.id
                   AND selection.event_id = submissions.event_id
                   AND selection.track_id = ?
                   AND current_track.name = ?
              )
           )
           AND (
             ? <> 'published'
             OR ${decisionAuthorityGuardSql("submissions.event_id")}
           )
           AND (
             ? <> 'published'
             OR (
               EXISTS (
                 SELECT 1
                   FROM communication_template_versions decision_version
                   JOIN communication_templates decision_template
                     ON decision_template.id = decision_version.template_id
                    AND decision_template.event_id = decision_version.event_id
                  WHERE decision_version.id = ?
                    AND decision_version.event_id = submissions.event_id
                    AND decision_template.status = 'active'
                    AND decision_version.status = 'published'
                    AND decision_version.category = 'decision'
                    AND decision_version.channel = 'email'
                    AND decision_version.name = ?
                    AND decision_version.version_number = ?
                    AND decision_version.subject_template = ?
                    AND decision_version.content_json = ?
               )
               AND EXISTS (
                 SELECT 1 FROM sender_profiles decision_sender
                  WHERE decision_sender.id = ?
                    AND decision_sender.event_id = submissions.event_id
                    AND decision_sender.status = 'verified'
                    AND decision_sender.provider = ?
                    AND decision_sender.from_name = ?
                    AND decision_sender.from_email = ?
                    AND decision_sender.reply_to_email IS ?
               )
               AND COALESCE(
                 (SELECT recipient.email FROM people recipient
                   WHERE recipient.id = submissions.submitter_person_id),
                 submissions.submitter_email
               ) = ?
               AND submissions.submitter_person_id IS ?
               AND COALESCE(
                 (SELECT recipient.display_name FROM people recipient
                   WHERE recipient.id = submissions.submitter_person_id),
                 COALESCE(
                   (SELECT recipient.email FROM people recipient
                     WHERE recipient.id = submissions.submitter_person_id),
                   submissions.submitter_email
                 )
               ) = ?
               AND EXISTS (
                 SELECT 1 FROM events notification_event
                  WHERE notification_event.id = submissions.event_id
                    AND notification_event.name = ?
                    AND notification_event.brand_accent = ?
                    AND notification_event.starts_at = ?
                    AND notification_event.ends_at = ?
               )
             )
           )
      `,
    ).bind(
      submissionStatus,
      decisionId,
      submission.id,
      viewer.eventId,
      submission.revision,
      ...decisionCycleGuard.bindings,
      ...notificationFeedbackGuardBindings,
      status,
      parsed.decision,
      ...speakerSetBindings,
      parsed.decision,
      sessionTrack?.id ?? null,
      sessionTrack?.name ?? null,
      status,
      ...decisionAuthorityBindings(viewer.role),
      status,
      notificationTemplateVersionId,
      notificationIntent?.templateName ?? null,
      notificationIntent?.templateVersionNumber ?? null,
      notificationIntent?.templateSubject ?? null,
      notificationIntent?.templateContentJson ?? null,
      notificationSenderProfileId,
      notificationIntent?.senderProvider ?? null,
      notificationIntent?.senderFromName ?? null,
      notificationIntent?.senderFromEmail ?? null,
      notificationIntent?.senderReplyToEmail ?? null,
      notificationAddress,
      notificationIntent?.recipientPersonId ?? null,
      notificationIntent?.recipientName ?? null,
      notificationIntent?.eventName ?? null,
      notificationIntent?.eventBrandAccent ?? null,
      notificationIntent?.eventStartsAt ?? null,
      notificationIntent?.eventEndsAt ?? null,
    ),
    env.DB.prepare(
      `
        UPDATE submission_decisions SET status = 'superseded'
         WHERE event_id = ? AND submission_id = ? AND status = 'draft'
           AND EXISTS (
             SELECT 1 FROM submissions
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
    ).bind(
      viewer.eventId,
      submission.id,
      submission.id,
      viewer.eventId,
      decisionId,
    ),
    env.DB.prepare(
      `
        UPDATE evaluator_assignments
           SET status = 'cancelled', revision = revision + 1,
               last_operation_id = ?, cancellation_reason = 'decision_published'
         WHERE event_id = ? AND submission_id = ?
           AND status IN ('assigned','in_progress','reopened')
           AND ? = 'published'
           AND EXISTS (
             SELECT 1
               FROM evaluation_rounds current_round
               JOIN evaluation_plans current_plan
                 ON current_plan.id = current_round.plan_id
                AND current_plan.event_id = current_round.event_id
              WHERE current_round.id = evaluator_assignments.round_id
                AND current_round.event_id = evaluator_assignments.event_id
                AND current_round.status <> 'archived'
                AND current_plan.status <> 'archived'
           )
           AND EXISTS (
             SELECT 1 FROM submissions
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
    ).bind(
      decisionId,
      viewer.eventId,
      submission.id,
      status,
      submission.id,
      viewer.eventId,
      decisionId,
    ),
    env.DB.prepare(
      `
        INSERT INTO submission_decisions (
          id, event_id, submission_id, round_id, revision_number, status, decision,
          decided_by_person_id, rationale, notification_feedback_json,
          effect_preview_json, idempotency_key, notification_operation_id,
          decided_at, published_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(),
               CASE WHEN ? = 'published' THEN unixepoch() END
         WHERE EXISTS (
           SELECT 1 FROM submissions
            WHERE id = ? AND event_id = ? AND last_operation_id = ?
         )
      `,
    ).bind(
      decisionId,
      viewer.eventId,
      submission.id,
      roundId,
      revision,
      status,
      parsed.decision,
      viewer.personId,
      parsed.rationale || null,
      JSON.stringify(notificationFeedback),
      JSON.stringify({
        createsSession: Boolean(sessionId),
        materializesOnboardingTaskPlan: Boolean(sessionId),
        queuesNotification: Boolean(notificationOperationId),
        roundId,
        planId,
        reviewEvidenceOverride: status === "published" && roundId === null,
        includeReviewerFeedback: parsed.includeReviewerFeedback,
        sessionTrackId: sessionTrack?.id ?? null,
        sessionTrackName: sessionTrack?.name ?? null,
        sessionFormatKey: parsed.decision === "accepted" ? format : null,
        sessionDurationMinutes: parsed.sessionDurationMinutes ?? null,
      }),
      `decision:${submission.id}:${revision}`,
      notificationOperationId,
      status,
      submission.id,
      viewer.eventId,
      decisionId,
    ),
    ...(sessionId
      ? [
          env.DB.prepare(
            `
          INSERT INTO sessions (
            id, event_id, source_submission_id, track_id, title, slug, description, format,
            duration_minutes, status, visibility, revision, created_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unscheduled', 'public', 1, unixepoch(), unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM submission_decisions
              WHERE id = ? AND event_id = ? AND status = 'published' AND decision = 'accepted'
           )
             AND EXISTS (
               SELECT 1 FROM submission_track_selections selection
               JOIN tracks current_track
                 ON current_track.id = selection.track_id
                AND current_track.event_id = selection.event_id
                WHERE selection.submission_id = ? AND selection.event_id = ?
                  AND selection.track_id = ?
                  AND current_track.name = ?
             )
        `,
          ).bind(
            sessionId,
            viewer.eventId,
            submission.id,
            requireValue(sessionTrack, "Required sessionTrack is unavailable.")
              .id,
            sessionTitle,
            slug,
            sessionDescription,
            format,
            sessionDurationMinutes,
            decisionId,
            viewer.eventId,
            submission.id,
            viewer.eventId,
            requireValue(sessionTrack, "Required sessionTrack is unavailable.")
              .id,
            requireValue(sessionTrack, "Required sessionTrack is unavailable.")
              .name,
          ),
          env.DB.prepare(
            `
          INSERT INTO session_speakers (
            session_id, event_id, person_id, position, role_label,
            participation_status, participation_confirmed_at, visibility
          )
          SELECT ?, event_id, person_id, position,
                 CASE WHEN is_primary = 1 THEN 'Primary speaker' ELSE 'Co-speaker' END,
                 'confirmed', unixepoch(), 'public'
            FROM submission_speakers
           WHERE submission_id = ? AND event_id = ? AND person_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND event_id = ?)
        `,
          ).bind(
            sessionId,
            submission.id,
            viewer.eventId,
            sessionId,
            viewer.eventId,
          ),
          ...materializePublishedResourceAcknowledgementsForSession(
            env,
            viewer.eventId,
            sessionId,
          ),
          ...speakerMemberships.flatMap(({ membershipId, personId }) => [
            env.DB.prepare(
              `
              INSERT INTO memberships (
                id, organisation_id, event_id, person_id, role, invited_at,
                invitation_expires_at, accepted_at, revoked_at, created_at
              )
              SELECT ?, ?, ?, ?, 'speaker', unixepoch(),
                     unixepoch() + 604800, NULL, NULL, unixepoch()
               WHERE EXISTS (
                 SELECT 1 FROM sessions
                  WHERE id = ? AND event_id = ?
               )
              ON CONFLICT(event_id, person_id, role)
              WHERE event_id IS NOT NULL DO UPDATE SET
                invited_at = CASE
                  WHEN memberships.accepted_at IS NULL
                    OR memberships.revoked_at IS NOT NULL
                  THEN unixepoch() ELSE memberships.invited_at END,
                invitation_expires_at = CASE
                  WHEN memberships.accepted_at IS NULL
                    OR memberships.revoked_at IS NOT NULL
                  THEN unixepoch() + 604800
                  ELSE memberships.invitation_expires_at END,
                accepted_at = CASE
                  WHEN memberships.revoked_at IS NOT NULL THEN NULL
                  ELSE memberships.accepted_at END,
                revoked_at = NULL
            `,
            ).bind(
              membershipId,
              viewer.organisationId,
              viewer.eventId,
              personId,
              sessionId,
              viewer.eventId,
            ),
            env.DB.prepare(
              `
              INSERT INTO audit_events (
                id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
                entity_type, entity_id, metadata_json, created_at
              )
              SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'membership.speaker.invited',
                     'membership', membership.id, ?, unixepoch()
                FROM memberships membership
               WHERE membership.event_id = ? AND membership.person_id = ?
                 AND membership.role = 'speaker'
                 AND membership.accepted_at IS NULL
                 AND membership.revoked_at IS NULL
                 AND membership.invitation_expires_at > unixepoch()
                 AND EXISTS (
                   SELECT 1 FROM sessions
                    WHERE id = ? AND event_id = ?
                 )
            `,
            ).bind(
              crypto.randomUUID(),
              viewer.organisationId,
              viewer.eventId,
              viewer.personId,
              JSON.stringify({ sessionId, submissionId: submission.id }),
              viewer.eventId,
              personId,
              sessionId,
              viewer.eventId,
            ),
          ]),
          ...speakerInvitationPlans.flatMap((plan) => plan.statements),
          ...buildAcceptanceTaskPlanStatements({
            env,
            viewer,
            submissionId: submission.id,
            sessionId,
            decisionId,
          }),
        ]
      : []),
    ...(notificationIntent
      ? [
          env.DB.prepare(
            `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json,
          progress_completed, progress_total, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'decision.notification', ?, ?, 'queued', ?, 0, 1, unixepoch(), unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM submission_decisions
            WHERE id = ? AND event_id = ? AND status = 'published'
         )
      `,
          ).bind(
            notificationIntent.operationId,
            viewer.organisationId,
            viewer.eventId,
            viewer.personId,
            notificationIntent.operationIdempotencyKey,
            notificationIntent.correlationId,
            notificationIntent.queuePayloadJson,
            decisionId,
            viewer.eventId,
          ),
          env.DB.prepare(
            `
        INSERT INTO communications (
          id, event_id, template_version_id, sender_profile_id, operation_id,
          idempotency_key, kind, channel, status, audience_json,
          content_snapshot_json, recipient_count, queued_at,
          created_by_person_id, created_at, updated_at
        )
        SELECT ?, decision.event_id, version.id, sender.id, operation.id,
               ?, 'transactional', 'email', 'queued', ?, ?, 1, unixepoch(),
               ?, unixepoch(), unixepoch()
          FROM submission_decisions decision
          JOIN operation_jobs operation
            ON operation.id = decision.notification_operation_id
           AND operation.event_id = decision.event_id
           AND operation.organisation_id = ?
           AND operation.status = 'queued'
          JOIN communication_template_versions version
            ON version.id = ? AND version.event_id = decision.event_id
           AND version.status = 'published' AND version.category = 'decision'
           AND version.channel = 'email' AND version.name = ?
           AND version.version_number = ? AND version.subject_template = ?
           AND version.content_json = ?
          JOIN communication_templates template
            ON template.id = version.template_id
           AND template.event_id = version.event_id
           AND template.status = 'active'
          JOIN sender_profiles sender
            ON sender.id = ? AND sender.event_id = decision.event_id
           AND sender.status = 'verified' AND sender.provider = ?
           AND sender.from_name = ? AND sender.from_email = ?
           AND sender.reply_to_email IS ?
          JOIN events event
            ON event.id = decision.event_id AND event.organisation_id = ?
           AND event.name = ? AND event.brand_accent = ?
           AND event.starts_at = ? AND event.ends_at = ?
         WHERE decision.id = ? AND decision.event_id = ?
           AND decision.status = 'published'
      `,
          ).bind(
            notificationIntent.communicationId,
            notificationIntent.operationIdempotencyKey,
            notificationIntent.audienceJson,
            notificationIntent.contentSnapshotJson,
            viewer.personId,
            viewer.organisationId,
            notificationIntent.templateVersionId,
            notificationIntent.templateName,
            notificationIntent.templateVersionNumber,
            notificationIntent.templateSubject,
            notificationIntent.templateContentJson,
            notificationIntent.senderProfileId,
            notificationIntent.senderProvider,
            notificationIntent.senderFromName,
            notificationIntent.senderFromEmail,
            notificationIntent.senderReplyToEmail,
            viewer.organisationId,
            notificationIntent.eventName,
            notificationIntent.eventBrandAccent,
            notificationIntent.eventStartsAt,
            notificationIntent.eventEndsAt,
            decisionId,
            viewer.eventId,
          ),
          env.DB.prepare(
            `
        INSERT INTO communication_deliveries (
          id, event_id, communication_id, person_id, recipient_address,
          recipient_name, source_id, source_values_json, channel, provider,
          idempotency_key, status, rendered_subject, rendered_body_sha256,
          created_at, updated_at
        )
        SELECT ?, communication.event_id, communication.id, ?, ?, ?, ?, ?,
               'email', ?, ?, 'queued', ?, ?, unixepoch(), unixepoch()
          FROM communications communication
         WHERE communication.id = ? AND communication.event_id = ?
           AND communication.operation_id = ?
           AND communication.status = 'queued'
      `,
          ).bind(
            notificationIntent.deliveryId,
            notificationIntent.recipientPersonId,
            notificationIntent.recipientAddress,
            notificationIntent.recipientName,
            submission.id,
            notificationIntent.sourceValuesJson,
            notificationIntent.senderProvider,
            notificationIntent.deliveryIdempotencyKey,
            notificationIntent.renderedSubject,
            notificationIntent.renderedBodySha256,
            notificationIntent.communicationId,
            viewer.eventId,
            notificationIntent.operationId,
          ),
          env.DB.prepare(
            `
        INSERT INTO operation_items (
          id, operation_id, item_key, entity_type, entity_id, status,
          result_json, updated_at
        )
        SELECT ?, operation.id, ?, 'communication_delivery', delivery.id,
               'pending', json_object('sourceId', ?), unixepoch()
          FROM operation_jobs operation
          JOIN communication_deliveries delivery
            ON delivery.id = ? AND delivery.event_id = operation.event_id
         WHERE operation.id = ? AND operation.event_id = ?
           AND operation.status = 'queued'
      `,
          ).bind(
            notificationIntent.operationItemId,
            notificationIntent.deliveryIdempotencyKey,
            submission.id,
            notificationIntent.deliveryId,
            notificationIntent.operationId,
            viewer.eventId,
          ),
          env.DB.prepare(
            `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id,
          actor_person_id, action, entity_type, entity_id, correlation_id,
          metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?,
               'decision.notification.prepared', 'communication', ?, ?, ?,
               unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM communication_deliveries
            WHERE id = ? AND event_id = ? AND communication_id = ?
         )
      `,
          ).bind(
            `decision-notification-prepared:${notificationIntent.operationId}`,
            viewer.organisationId,
            viewer.eventId,
            viewer.personId,
            notificationIntent.communicationId,
            notificationIntent.operationId,
            JSON.stringify({
              decisionId,
              operationId: notificationIntent.operationId,
              templateVersionId: notificationIntent.templateVersionId,
              deliveryId: notificationIntent.deliveryId,
              renderedSubject: notificationIntent.renderedSubject,
              renderedBodySha256: notificationIntent.renderedBodySha256,
            }),
            notificationIntent.deliveryId,
            viewer.eventId,
            notificationIntent.communicationId,
          ),
          env.DB.prepare(
            `
        INSERT INTO event_changes (
          event_id, entity_type, entity_id, change_type, correlation_id,
          created_at
        )
        SELECT ?, 'communication', ?, 'created', ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM communication_deliveries
            WHERE id = ? AND event_id = ? AND communication_id = ?
         )
      `,
          ).bind(
            viewer.eventId,
            notificationIntent.communicationId,
            notificationIntent.correlationId,
            notificationIntent.deliveryId,
            viewer.eventId,
            notificationIntent.communicationId,
          ),
        ]
      : []),
    env.DB.prepare(
      `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, ?, 'submission_decision', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM submissions
            WHERE id = ? AND event_id = ? AND last_operation_id = ?
         )
           AND (
             ? = 'published'
             OR EXISTS (
               SELECT 1 FROM submission_decisions WHERE id = ? AND event_id = ?
             )
           )
      `,
    ).bind(
      auditEventId,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      parsed.release ? "decision.published" : "decision.drafted",
      decisionId,
      JSON.stringify({
        decision: parsed.decision,
        sessionId,
        sessionTrackId: sessionTrack?.id ?? null,
        sessionTrackName: sessionTrack?.name ?? null,
        notificationOperationId,
        planId,
        reviewEvidenceOverride: parsed.release && roundId === null,
      }),
      submission.id,
      viewer.eventId,
      decisionId,
      status,
      decisionId,
      viewer.eventId,
    ),
  ];
}
