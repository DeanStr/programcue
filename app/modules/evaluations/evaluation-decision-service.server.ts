import { requireValue } from "~/lib/required-value";
import {
  type DecisionNotificationIntent,
  prepareDecisionNotificationIntent,
} from "~/modules/communications/decision-notification-intent.server";
import {
  parseSessionFormatsConfiguration,
  type SessionFormatConfiguration,
} from "~/modules/events/event-configuration";
import { submittedSnapshotSchema } from "~/modules/submissions/submission-schema";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  persistAcceptedSpeakerQueueFailure,
  prepareAcceptedSpeakerInvitationPlans,
} from "./accepted-speaker-invitation.server";
import {
  assertAcceptanceTaskPlan,
  assertAcceptanceTaskPlanMaterialized,
  assertDecisionViewerEvent,
} from "./evaluation-decision-acceptance-guard.server";
import { acceptedSpeakerInvitationOutcome } from "./evaluation-decision-invitation-outcome.server";
import {
  buildDecisionStatements,
  type DecisionReviewFeedbackEvidence,
  type DecisionSubmission,
} from "./evaluation-decision-statements.server";
import {
  EvaluationDecisionAuthorityError,
  EvaluationDecisionFinalError,
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";
import { decisionReopenSchema, decisionSchema } from "./evaluation-schema";

export type DecisionReopenNotificationOutcome =
  | "cancelled_before_delivery"
  | "already_delivered"
  | "legacy_unverified";

const decisionReopenLegacyUnlinkedSql = `
  EXISTS (
    SELECT 1 FROM audit_events legacy_unlinked
     WHERE legacy_unlinked.id =
           'migration-0041-decision-notification-unlinked:' || ?
       AND legacy_unlinked.organisation_id = ?
       AND legacy_unlinked.event_id = ?
       AND legacy_unlinked.actor_kind = 'system'
       AND legacy_unlinked.origin = 'internal'
       AND legacy_unlinked.action = 'decision.notification.legacy_unlinked'
       AND legacy_unlinked.entity_type = 'submission_decision'
       AND legacy_unlinked.entity_id = ?
  )`;

const decisionReopenNotificationGraphIntactSql = `
  (
    (
      ? IS NULL
      AND ${decisionReopenLegacyUnlinkedSql}
    )
    OR (
      ? IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM operation_jobs obsolete_notification
         WHERE obsolete_notification.id = ?
           AND obsolete_notification.event_id = ?
           AND obsolete_notification.organisation_id = ?
           AND obsolete_notification.type = 'decision.notification'
           AND obsolete_notification.status IN ('cancelled','completed')
      )
      AND EXISTS (
        SELECT 1 FROM communications communication
         WHERE communication.operation_id = ?
           AND communication.event_id = ?
      )
      AND EXISTS (
        SELECT 1 FROM communication_deliveries delivery
         JOIN communications communication
           ON communication.id = delivery.communication_id
          AND communication.event_id = delivery.event_id
          AND communication.operation_id = ?
        WHERE delivery.event_id = ?
      )
      AND EXISTS (
        SELECT 1 FROM operation_items item
         WHERE item.operation_id = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM communications communication
         WHERE communication.operation_id = ?
           AND communication.event_id = ?
           AND communication.status IN ('draft','scheduled','queued','failed')
      )
      AND NOT EXISTS (
        SELECT 1 FROM communication_deliveries delivery
         JOIN communications communication
           ON communication.id = delivery.communication_id
          AND communication.event_id = delivery.event_id
          AND communication.operation_id = ?
        WHERE delivery.event_id = ?
          AND delivery.status IN ('queued','failed')
      )
      AND NOT EXISTS (
        SELECT 1 FROM operation_items item
         WHERE item.operation_id = ?
           AND item.status IN ('pending','failed')
      )
    )
  )`;

function decisionReopenLegacyUnlinkedBindings(
  decisionId: string,
  organisationId: string,
  eventId: string,
) {
  return [decisionId, organisationId, eventId, decisionId] as const;
}

function decisionReopenNotificationGraphBindings(
  notificationOperationId: string | null,
  decisionId: string,
  eventId: string,
  organisationId: string,
) {
  return [
    notificationOperationId,
    ...decisionReopenLegacyUnlinkedBindings(
      decisionId,
      organisationId,
      eventId,
    ),
    notificationOperationId,
    notificationOperationId,
    eventId,
    organisationId,
    notificationOperationId,
    eventId,
    notificationOperationId,
    eventId,
    notificationOperationId,
    notificationOperationId,
    eventId,
    notificationOperationId,
    eventId,
    notificationOperationId,
  ] as const;
}

export class EvaluationDecisionService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private async loadReopenContext(viewer: Viewer, input: unknown) {
    await assertDecisionViewerEvent(this.env, viewer);
    if (viewer.role !== "owner" && viewer.role !== "administrator") {
      throw new EvaluationDecisionAuthorityError();
    }
    const parsed = decisionReopenSchema.parse(input);
    const released = await this.env.DB.prepare(
      `SELECT decision.id AS decisionId, decision.decision,
              submission.status AS submissionStatus, submission.revision,
              decision.notification_operation_id AS notificationOperationId,
              EXISTS (
                SELECT 1 FROM audit_events legacy_unlinked
                 WHERE legacy_unlinked.id =
                       'migration-0041-decision-notification-unlinked:' ||
                       decision.id
                   AND legacy_unlinked.organisation_id = event.organisation_id
                   AND legacy_unlinked.event_id = decision.event_id
                   AND legacy_unlinked.actor_kind = 'system'
                   AND legacy_unlinked.origin = 'internal'
                   AND legacy_unlinked.action =
                       'decision.notification.legacy_unlinked'
                   AND legacy_unlinked.entity_type = 'submission_decision'
                   AND legacy_unlinked.entity_id = decision.id
              ) AS hasLegacyUnlinkedMarker
         FROM submission_decisions decision
         JOIN submissions submission
           ON submission.id = decision.submission_id
          AND submission.event_id = decision.event_id
         JOIN events event
           ON event.id = decision.event_id AND event.organisation_id = ?
        WHERE decision.event_id = ? AND decision.submission_id = ?
          AND decision.status = 'published'
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId, parsed.submissionId)
      .first<{
        decisionId: string;
        decision: "accepted" | "rejected" | "waitlisted";
        submissionStatus: string;
        revision: number;
        notificationOperationId: string | null;
        hasLegacyUnlinkedMarker: number;
      }>();
    if (!released) {
      throw new EvaluationStateError(
        "No released decision is available to reopen.",
      );
    }
    if (released.decision === "accepted") {
      throw new EvaluationValidationError(
        "A released acceptance owns programme, speaker and task records. Correct the linked session workflow before changing that outcome.",
      );
    }
    if (released.submissionStatus !== released.decision) {
      throw new EvaluationRevisionConflictError(
        "The submission no longer matches its released decision. Refresh before reopening it.",
      );
    }
    if (
      released.notificationOperationId === null &&
      Number(released.hasLegacyUnlinkedMarker) !== 1
    ) {
      throw new EvaluationStateError(
        "The released decision is missing its notification operation without the migration audit marker.",
      );
    }
    return { parsed, released };
  }

  async reopen(viewer: Viewer, input: unknown) {
    const { parsed, released } = await this.loadReopenContext(viewer, input);
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const nextRevision = released.revision + 1;
    const [auditInsert, , , , , decisionUpdate, submissionUpdate, eventChange] =
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id, event_id,
             actor_person_id, action, entity_type, entity_id, correlation_id,
             metadata_json, created_at
           )
           SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'decision.reopened',
                  'submission_decision', decision.id, ?,
                  json_object('submissionId', decision.submission_id,
                              'priorDecision', decision.decision,
                              'reason', ?),
                  unixepoch()
             FROM submission_decisions decision
             JOIN submissions submission
               ON submission.id = decision.submission_id
              AND submission.event_id = decision.event_id
             JOIN events event
               ON event.id = decision.event_id AND event.organisation_id = ?
            WHERE decision.id = ? AND decision.event_id = ?
              AND decision.submission_id = ? AND decision.status = 'published'
              AND decision.decision = ? AND decision.decision <> 'accepted'
              AND submission.revision = ? AND submission.status = ?
              AND (
                (
                  ? IS NULL
                  AND ${decisionReopenLegacyUnlinkedSql}
                )
                OR (
                  ? IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM operation_jobs active_notification
                     WHERE active_notification.id = ?
                       AND active_notification.event_id = decision.event_id
                       AND active_notification.organisation_id = event.organisation_id
                       AND active_notification.status = 'running'
                  )
                )
              )`,
        ).bind(
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          operationId,
          parsed.reason,
          viewer.organisationId,
          released.decisionId,
          viewer.eventId,
          parsed.submissionId,
          released.decision,
          released.revision,
          released.decision,
          released.notificationOperationId,
          ...decisionReopenLegacyUnlinkedBindings(
            released.decisionId,
            viewer.organisationId,
            viewer.eventId,
          ),
          released.notificationOperationId,
          released.notificationOperationId,
        ),
        this.env.DB.prepare(
          `UPDATE communications
              SET status = 'cancelled', cancelled_at = unixepoch(),
                  updated_at = unixepoch()
            WHERE operation_id = ? AND event_id = ?
              AND status IN ('draft','scheduled','queued','failed')
              AND EXISTS (
                SELECT 1 FROM audit_events
                 WHERE id = ? AND organisation_id = ? AND event_id = ?
              )`,
        ).bind(
          released.notificationOperationId,
          viewer.eventId,
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
        ),
        this.env.DB.prepare(
          `UPDATE communication_deliveries
              SET status = 'cancelled', updated_at = unixepoch()
            WHERE event_id = ? AND status IN ('queued','failed')
              AND communication_id IN (
                SELECT communication.id FROM communications communication
                 WHERE communication.operation_id = ?
                   AND communication.event_id = communication_deliveries.event_id
                   AND communication.status = 'cancelled'
              )`,
        ).bind(viewer.eventId, released.notificationOperationId),
        this.env.DB.prepare(
          `UPDATE operation_items
              SET status = 'skipped', error_code = 'DECISION_REOPENED',
                  error_message = 'The original decision was reopened before delivery.',
                  completed_at = unixepoch(), updated_at = unixepoch()
            WHERE operation_id = ? AND status IN ('pending','failed')
              AND EXISTS (
                SELECT 1 FROM audit_events
                 WHERE id = ? AND organisation_id = ? AND event_id = ?
              )`,
        ).bind(
          released.notificationOperationId,
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
        ),
        this.env.DB.prepare(
          `UPDATE operation_jobs
              SET status = 'cancelled', last_error = NULL,
                  completed_at = unixepoch(), claim_token = NULL,
                  claim_expires_at = NULL, updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND organisation_id = ?
              AND type = 'decision.notification'
              AND status IN (
                'queued','queue_failed','received','retrying','failed','partially_failed'
              )
              AND claim_token IS NULL
              AND EXISTS (
                SELECT 1 FROM audit_events
                 WHERE id = ? AND organisation_id = ? AND event_id = ?
              )`,
        ).bind(
          released.notificationOperationId,
          viewer.eventId,
          viewer.organisationId,
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
        ),
        this.env.DB.prepare(
          `UPDATE submission_decisions
            SET status = 'superseded'
          WHERE id = ? AND event_id = ? AND submission_id = ?
            AND status = 'published' AND decision = ?
            AND EXISTS (
              SELECT 1 FROM submissions
               WHERE submissions.id = submission_decisions.submission_id
                 AND submissions.event_id = submission_decisions.event_id
                 AND submissions.revision = ? AND submissions.status = ?
            )
            AND EXISTS (
              SELECT 1 FROM audit_events
               WHERE id = ? AND organisation_id = ? AND event_id = ?
            )
            AND ${decisionReopenNotificationGraphIntactSql}`,
        ).bind(
          released.decisionId,
          viewer.eventId,
          parsed.submissionId,
          released.decision,
          released.revision,
          released.decision,
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
          ...decisionReopenNotificationGraphBindings(
            released.notificationOperationId,
            released.decisionId,
            viewer.eventId,
            viewer.organisationId,
          ),
        ),
        this.env.DB.prepare(
          `UPDATE submissions
            SET status = 'decision_ready', revision = revision + 1,
                last_operation_id = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND revision = ? AND status = ?
            AND EXISTS (
              SELECT 1 FROM submission_decisions decision
               WHERE decision.id = ? AND decision.event_id = submissions.event_id
                 AND decision.status = 'superseded'
            )
            AND EXISTS (
              SELECT 1 FROM audit_events
               WHERE id = ? AND organisation_id = ? AND event_id = ?
            )`,
        ).bind(
          operationId,
          parsed.submissionId,
          viewer.eventId,
          released.revision,
          released.decision,
          released.decisionId,
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
        ),
        this.env.DB.prepare(
          `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id,
           created_at
         )
         SELECT ?, 'submission_decision', ?, 'updated', ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM submissions
             WHERE id = ? AND event_id = ? AND last_operation_id = ?
          )`,
        ).bind(
          viewer.eventId,
          released.decisionId,
          operationId,
          parsed.submissionId,
          viewer.eventId,
          operationId,
        ),
        atomicBatchGuardStatement(
          this.env,
          `EXISTS (
            SELECT 1 FROM audit_events audit WHERE audit.id = ?
          ) AND NOT (
            EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ? AND audit.organisation_id = ?
                 AND audit.event_id = ? AND audit.actor_person_id = ?
                 AND audit.action = 'decision.reopened'
                 AND audit.entity_type = 'submission_decision'
                 AND audit.entity_id = ? AND audit.correlation_id = ?
                 AND json_extract(audit.metadata_json, '$.reason') = ?
                 AND json_extract(audit.metadata_json, '$.submissionId') = ?
            ) AND EXISTS (
              SELECT 1 FROM submission_decisions decision
               WHERE decision.id = ? AND decision.event_id = ?
                 AND decision.status = 'superseded'
            ) AND EXISTS (
              SELECT 1 FROM submissions submission
               WHERE submission.id = ? AND submission.event_id = ?
                 AND submission.status = 'decision_ready'
                 AND submission.revision = ?
                 AND submission.last_operation_id = ?
            ) AND EXISTS (
              SELECT 1 FROM event_changes change
               WHERE change.event_id = ? AND change.entity_type = 'submission_decision'
                 AND change.entity_id = ? AND change.change_type = 'updated'
                 AND change.correlation_id = ?
            ) AND ${decisionReopenNotificationGraphIntactSql}
          )`,
          [
            auditEventId,
            auditEventId,
            viewer.organisationId,
            viewer.eventId,
            viewer.personId,
            released.decisionId,
            operationId,
            parsed.reason,
            parsed.submissionId,
            released.decisionId,
            viewer.eventId,
            parsed.submissionId,
            viewer.eventId,
            nextRevision,
            operationId,
            viewer.eventId,
            released.decisionId,
            operationId,
            ...decisionReopenNotificationGraphBindings(
              released.notificationOperationId,
              released.decisionId,
              viewer.eventId,
              viewer.organisationId,
            ),
          ],
        ),
      ]).catch((error: unknown) => {
        if (isAtomicBatchGuardError(error)) {
          throw new Error(
            "The reopened decision could not record its complete audit, decision, submission, change, and notification evidence.",
            { cause: error },
          );
        }
        throw error;
      });
    if (
      (auditInsert.meta.changes ?? 0) !== 1 ||
      (decisionUpdate.meta.changes ?? 0) !== 1 ||
      (submissionUpdate.meta.changes ?? 0) !== 1 ||
      (eventChange.meta.changes ?? 0) !== 1
    ) {
      throw new EvaluationRevisionConflictError(
        "The decision changed before it could be reopened. Refresh before trying again.",
      );
    }
    return {
      decisionId: released.decisionId,
      submissionId: parsed.submissionId,
      notificationOutcome: await this.notificationReopenOutcome(
        viewer,
        released.decisionId,
        released.notificationOperationId,
      ),
    };
  }

  private async notificationReopenOutcome(
    viewer: Viewer,
    decisionId: string,
    notificationOperationId: string | null,
  ): Promise<DecisionReopenNotificationOutcome> {
    if (notificationOperationId === null) {
      const legacyUnlinked = await this.env.DB.prepare(
        `SELECT 1 AS present WHERE ${decisionReopenLegacyUnlinkedSql}`,
      )
        .bind(
          ...decisionReopenLegacyUnlinkedBindings(
            decisionId,
            viewer.organisationId,
            viewer.eventId,
          ),
        )
        .first();
      if (!legacyUnlinked) {
        throw new Error(
          "The reopened decision is missing its notification operation without the migration audit marker.",
        );
      }
      return "legacy_unverified";
    }
    const notification = await this.env.DB.prepare(
      `SELECT status FROM operation_jobs
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND type = 'decision.notification'`,
    )
      .bind(notificationOperationId, viewer.eventId, viewer.organisationId)
      .first<{ status: string }>();
    if (notification?.status === "cancelled") {
      return "cancelled_before_delivery";
    }
    if (notification?.status === "completed") {
      return "already_delivered";
    }
    throw new Error(
      "The reopened decision left its notification graph in an unexpected state.",
    );
  }

  private async recoverDecision(viewer: Viewer, commandId?: string) {
    if (commandId) {
      const recovered = await this.env.DB.prepare(
        `SELECT decision.id AS decisionId,
                decision.status AS decisionStatus,
                decision.decision AS decision,
                decision.submission_id AS submissionId,
                session.id AS sessionId,
                operation.id AS notificationOperationId,
                operation.status AS notificationStatus
           FROM submission_decisions decision
           JOIN submissions submission
             ON submission.id = decision.submission_id
            AND submission.event_id = decision.event_id
           JOIN events event
             ON event.id = decision.event_id AND event.organisation_id = ?
           LEFT JOIN sessions session
             ON session.source_submission_id = decision.submission_id
            AND session.event_id = decision.event_id
           LEFT JOIN operation_jobs operation
             ON operation.event_id = decision.event_id
            AND operation.id = decision.notification_operation_id
          WHERE decision.id = ? AND decision.event_id = ?`,
      )
        .bind(viewer.organisationId, commandId, viewer.eventId)
        .first<{
          decisionId: string;
          decisionStatus: string;
          decision: string;
          submissionId: string;
          sessionId: string | null;
          notificationOperationId: string | null;
          notificationStatus: string | null;
        }>();
      if (recovered) {
        if (
          recovered.decisionStatus === "published" &&
          recovered.decision === "accepted" &&
          recovered.sessionId
        )
          await assertAcceptanceTaskPlanMaterialized(this.env, {
            eventId: viewer.eventId,
            submissionId: recovered.submissionId,
            sessionId: recovered.sessionId,
            decisionId: recovered.decisionId,
          });
        const speakerInvitations = await acceptedSpeakerInvitationOutcome(
          this.env,
          viewer,
          recovered.decisionId,
          recovered.sessionId,
        );
        return {
          decisionId: recovered.decisionId,
          sessionId: recovered.sessionId,
          notificationOperationId: recovered.notificationOperationId,
          notificationStatus:
            recovered.notificationStatus === "queue_failed"
              ? ("queue_failed" as const)
              : recovered.notificationOperationId
                ? ("queued" as const)
                : ("not_requested" as const),
          ...speakerInvitations,
        };
      }
    }
    return null;
  }

  async decide(viewer: Viewer, input: unknown, commandId?: string) {
    await assertDecisionViewerEvent(this.env, viewer);
    if (
      viewer.role !== "owner" &&
      viewer.role !== "administrator" &&
      viewer.role !== "committee_chair"
    ) {
      throw new EvaluationDecisionAuthorityError();
    }
    const parsed = decisionSchema.parse(input);
    const recovered = await this.recoverDecision(viewer, commandId);
    if (recovered) return recovered;
    if (
      parsed.release &&
      viewer.role !== "owner" &&
      viewer.role !== "administrator"
    ) {
      const plan = await this.env.DB.prepare(
        `
        SELECT decision_role AS decisionRole
          FROM evaluation_plans
         WHERE event_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 1
      `,
      )
        .bind(viewer.eventId)
        .first<{ decisionRole: string }>();
      if (
        viewer.role !== "committee_chair" ||
        plan?.decisionRole !== "committee_chair"
      ) {
        throw new EvaluationDecisionAuthorityError();
      }
    }
    const submission = await this.env.DB.prepare(
      `
      SELECT s.id, s.title, s.public_reference AS reference, s.format, s.category,
             COALESCE(person.email, s.submitter_email) AS notificationAddress,
             s.submitter_person_id AS notificationPersonId,
             COALESCE(person.display_name, person.email, s.submitter_email) AS notificationName,
             e.name AS eventName, e.brand_accent AS eventBrandAccent,
             e.starts_at AS eventStartsAt, e.ends_at AS eventEndsAt,
             s.status, s.revision, s.submitted_snapshot_json AS snapshotJson
        FROM submissions s JOIN events e ON e.id = s.event_id
        LEFT JOIN people person ON person.id = s.submitter_person_id
       WHERE s.id = ? AND s.event_id = ? AND e.organisation_id = ? AND s.status NOT IN ('draft','withdrawn')
    `,
    )
      .bind(parsed.submissionId, viewer.eventId, viewer.organisationId)
      .first<DecisionSubmission>();
    if (!submission)
      throw new EvaluationStateError(
        "Submission not found or cannot be decided.",
      );
    const terminalStatuses = new Set(["accepted", "waitlisted", "rejected"]);
    const prior = await this.env.DB.prepare(
      `
      SELECT COALESCE(MAX(revision_number), 0) AS revision,
             COALESCE(MAX(CASE WHEN status = 'published' THEN 1 ELSE 0 END), 0) AS hasPublished
        FROM submission_decisions WHERE event_id = ? AND submission_id = ?
    `,
    )
      .bind(viewer.eventId, submission.id)
      .first<{ revision: number; hasPublished: number }>();
    if (
      terminalStatuses.has(submission.status) ||
      Number(prior?.hasPublished ?? 0) > 0
    ) {
      throw new EvaluationDecisionFinalError();
    }
    const revision = (prior?.revision ?? 0) + 1;
    const completedRound = await this.env.DB.prepare(
      `
      SELECT a.round_id AS roundId
        FROM evaluator_assignments a
        JOIN reviews r
          ON r.assignment_id = a.id AND r.event_id = a.event_id
         AND r.status IN ('submitted','locked')
        JOIN evaluation_rounds round
          ON round.id = a.round_id AND round.event_id = a.event_id
        JOIN evaluation_plans plan
          ON plan.id = round.plan_id AND plan.event_id = round.event_id
       WHERE a.event_id = ? AND a.submission_id = ?
         AND plan.status IN ('active','closed')
         AND round.status IN ('active','closed')
         AND (SELECT COUNT(*) FROM evaluation_plans current_plan
               WHERE current_plan.event_id = a.event_id
                 AND current_plan.status <> 'archived') = 1
       ORDER BY round.round_number DESC LIMIT 1
    `,
    )
      .bind(viewer.eventId, submission.id)
      .first<{ roundId: string }>();
    if (parsed.release && !completedRound) {
      if (!parsed.confirmedWithoutReview) {
        throw new EvaluationValidationError(
          "Confirm the review-evidence override before releasing a decision without completed review evidence.",
        );
      }
    }
    const notificationFeedbackEvidence =
      parsed.includeReviewerFeedback && completedRound
        ? (
            await this.env.DB.prepare(
              `SELECT assignment.id AS assignmentId,
                      assignment.assigned_at AS assignedAt,
                      review.id AS reviewId,
                      review.revision AS reviewRevision,
                      review.status AS reviewStatus,
                      trim(COALESCE(review.submitter_feedback, '')) AS applicantFeedback
                 FROM evaluator_assignments assignment
                 JOIN reviews review
                   ON review.assignment_id = assignment.id
                  AND review.event_id = assignment.event_id
                WHERE assignment.event_id = ?
                  AND assignment.submission_id = ?
                  AND assignment.round_id = ?
                  AND review.status IN ('submitted','locked')
                ORDER BY assignment.assigned_at, assignment.id`,
            )
              .bind(viewer.eventId, submission.id, completedRound.roundId)
              .all<DecisionReviewFeedbackEvidence>()
          ).results
        : [];
    const notificationFeedback = notificationFeedbackEvidence
      .map((row) => row.applicantFeedback)
      .filter((feedback) => feedback.length > 0);
    const decisionId = commandId ?? crypto.randomUUID();
    const sessionId =
      parsed.release && parsed.decision === "accepted"
        ? commandId
          ? `session:${commandId}`
          : crypto.randomUUID()
        : null;
    let sessionTitle = "";
    let sessionDescription = "";
    let format = "";
    let sessionDurationMinutes = 0;
    let sessionTrack: { id: string; name: string } | null = null;
    let acceptedEvent: {
      name: string;
      brandAccent: string;
      startsAt: number;
      endsAt: number;
      venueName: string | null;
      city: string | null;
    } | null = null;
    if (parsed.decision === "accepted") {
      sessionTrack = await this.env.DB.prepare(
        `SELECT selection.track_id AS id, track.name
           FROM submission_track_selections selection
           JOIN tracks track
             ON track.id = selection.track_id
            AND track.event_id = selection.event_id
          WHERE selection.submission_id = ? AND selection.event_id = ?
            AND selection.track_id = ?`,
      )
        .bind(submission.id, viewer.eventId, parsed.sessionTrackId)
        .first<{ id: string; name: string }>();
      if (!sessionTrack) {
        throw new EvaluationValidationError(
          "Choose one of the tracks submitted with this proposal for the accepted session.",
        );
      }
      const event = await this.env.DB.prepare(
        `SELECT name, brand_accent AS brandAccent,
                starts_at AS startsAt, ends_at AS endsAt,
                venue_name AS venueName, city,
                session_formats_json AS sessionFormatsJson
           FROM events WHERE id = ? AND organisation_id = ?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{
          name: string;
          brandAccent: string;
          startsAt: number;
          endsAt: number;
          venueName: string | null;
          city: string | null;
          sessionFormatsJson: string;
        }>();
      if (!event) {
        throw new EvaluationStateError(
          "The accepted submission event is unavailable.",
        );
      }
      let configuredFormat: SessionFormatConfiguration | null = null;
      try {
        const configuredFormats = parseSessionFormatsConfiguration(
          event.sessionFormatsJson,
        );
        configuredFormat =
          configuredFormats.find(
            (candidate) => candidate.key === parsed.sessionFormatKey,
          ) ?? null;
      } catch (error) {
        throw new EvaluationStateError(
          error instanceof Error
            ? error.message
            : "The event has invalid session-format configuration.",
        );
      }
      if (!configuredFormat) {
        throw new EvaluationValidationError(
          "Choose a current session format for the accepted session.",
        );
      }
      format = configuredFormat.key;
      sessionDurationMinutes =
        parsed.sessionDurationMinutes ??
        configuredFormat.defaultDurationMinutes;
      acceptedEvent = event;
    }
    if (sessionId) {
      let rawSnapshot: unknown;
      try {
        rawSnapshot = JSON.parse(submission.snapshotJson ?? "null");
      } catch {
        rawSnapshot = null;
      }
      const snapshot = submittedSnapshotSchema.safeParse(rawSnapshot);
      if (!snapshot.success) {
        throw new EvaluationStateError(
          "The accepted submission is missing its valid immutable snapshot.",
        );
      }
      const title = snapshot.data.answers.title;
      sessionTitle = Array.isArray(title)
        ? title
            .map((value) => value.trim())
            .filter(Boolean)
            .join(", ")
        : typeof title === "string"
          ? title.trim()
          : "";
      if (!sessionTitle) {
        throw new EvaluationStateError(
          "The accepted submission snapshot is missing its session title.",
        );
      }
      const description = snapshot.data.answers.description;
      sessionDescription =
        typeof description === "string" ? description.trim() : "";
    }
    const notificationOperationId = parsed.release
      ? commandId
        ? `decision-notification:${commandId}`
        : crypto.randomUUID()
      : null;
    const status = parsed.release ? "published" : "draft";
    const submissionStatus = parsed.release
      ? parsed.decision
      : "decision_ready";
    const slug = `${
      (sessionTitle || submission.title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || "session"
    }-${submission.reference.toLowerCase()}`;
    const acceptedSpeakers = sessionId
      ? await this.env.DB.prepare(
          `
          SELECT DISTINCT person.id, person.email,
                 membership.id AS existingMembershipId,
                 membership.accepted_at AS membershipAcceptedAt,
                 membership.revoked_at AS membershipRevokedAt
            FROM submission_speakers submission_speaker
            JOIN people person ON person.id = submission_speaker.person_id
            LEFT JOIN memberships membership
              ON membership.event_id = submission_speaker.event_id
             AND membership.person_id = submission_speaker.person_id
             AND membership.role = 'speaker'
           WHERE submission_speaker.event_id = ?
             AND submission_speaker.submission_id = ?
             AND submission_speaker.person_id IS NOT NULL
           ORDER BY person.id
        `,
        )
          .bind(viewer.eventId, submission.id)
          .all<{
            id: string;
            email: string;
            existingMembershipId: string | null;
            membershipAcceptedAt: number | null;
            membershipRevokedAt: number | null;
          }>()
      : {
          results: [] as Array<{
            id: string;
            email: string;
            existingMembershipId: string | null;
            membershipAcceptedAt: number | null;
            membershipRevokedAt: number | null;
          }>,
        };
    if (sessionId && acceptedSpeakers.results.length === 0) {
      throw new EvaluationStateError(
        "An accepted session requires at least one claimed speaker before release.",
      );
    }
    if (sessionId) await assertAcceptanceTaskPlan(this.env, viewer.eventId);
    const speakerMemberships = acceptedSpeakers.results.map((speaker) => ({
      membershipId:
        speaker.existingMembershipId ??
        (commandId
          ? `speaker-membership:${commandId}:${speaker.id}`
          : crypto.randomUUID()),
      personId: speaker.id,
    }));
    const speakerInvitations = acceptedSpeakers.results
      .map((speaker, index) => ({
        ...speaker,
        membershipId: speakerMemberships[index].membershipId,
      }))
      .filter(
        (speaker) =>
          speaker.membershipAcceptedAt === null ||
          speaker.membershipRevokedAt !== null,
      );
    const operationsQueue = this.env.OPERATIONS_QUEUE;
    if (parsed.release && !operationsQueue) {
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    }
    let notificationIntent: DecisionNotificationIntent | null = null;
    if (parsed.release) {
      const preparedNotification = await prepareDecisionNotificationIntent(
        this.env,
        {
          viewer,
          decisionId,
          operationId: requireValue(
            notificationOperationId,
            "Released decision notification operation is unavailable.",
          ),
          submissionId: submission.id,
          submissionTitle: submission.title,
          decision: parsed.decision,
          rationale: parsed.rationale,
          feedback: notificationFeedback,
          recipientPersonId: submission.notificationPersonId,
          recipientAddress: submission.notificationAddress,
          recipientName: submission.notificationName,
          event: {
            name: submission.eventName,
            brandAccent: submission.eventBrandAccent,
            startsAt: submission.eventStartsAt,
            endsAt: submission.eventEndsAt,
          },
        },
      );
      if (preparedNotification.error) {
        throw new EvaluationValidationError(preparedNotification.error);
      }
      notificationIntent = preparedNotification.intent;
    }
    const speakerInvitationPlans =
      sessionId && acceptedEvent
        ? await prepareAcceptedSpeakerInvitationPlans({
            env: this.env,
            viewer,
            decisionId,
            sessionId,
            event: acceptedEvent,
            speakers: speakerInvitations,
          })
        : [];
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: parsed.release ? "decision.released" : "decision.recorded",
        entityType: "submission_decision",
        entityId: decisionId,
        idempotencyKey: `${parsed.release ? "decision.released" : "decision.recorded"}:${decisionId}`,
        correlationId: decisionId,
        data: {
          submissionId: submission.id,
          decision: parsed.decision,
          released: parsed.release,
          sessionId,
          sessionTrackId: sessionTrack?.id ?? null,
        },
      },
      auditEventId,
    );
    const statements = buildDecisionStatements({
      env: this.env,
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
      roundId: completedRound?.roundId ?? null,
      speakerMemberships,
      speakerInvitationPlans,
      auditEventId,
    });
    statements.push(...preparedWebhook.statements);
    const [updated] = await this.env.DB.batch(statements);
    if ((updated.meta.changes ?? 0) !== 1) {
      if (sessionId) {
        await assertAcceptanceTaskPlan(this.env, viewer.eventId);
        const pendingSpeaker = await this.env.DB.prepare(
          `
          SELECT 1 FROM submission_speakers
           WHERE event_id = ? AND submission_id = ? AND person_id IS NULL
           LIMIT 1
        `,
        )
          .bind(viewer.eventId, submission.id)
          .first();
        if (pendingSpeaker) {
          throw new EvaluationStateError(
            "Claim every co-speaker before releasing an accepted decision. No speaker will be silently omitted from the session.",
          );
        }
      }
      if (parsed.decision === "accepted") {
        const submittedTrack = await this.env.DB.prepare(
          `SELECT track.name
             FROM submission_track_selections selection
             JOIN tracks track
               ON track.id = selection.track_id
              AND track.event_id = selection.event_id
            WHERE selection.submission_id = ? AND selection.event_id = ?
              AND selection.track_id = ? LIMIT 1`,
        )
          .bind(submission.id, viewer.eventId, parsed.sessionTrackId)
          .first<{ name: string }>();
        if (!submittedTrack) {
          throw new EvaluationStateError(
            "The accepted session track is no longer one of the proposal's submitted tracks. Refresh before releasing it.",
          );
        }
        if (submittedTrack.name !== sessionTrack?.name) {
          throw new EvaluationStateError(
            "The accepted programme track was renamed after the decision preview. Refresh and confirm the current track name before releasing it.",
          );
        }
      }
      if (parsed.release && viewer.role === "committee_chair") {
        const authority = await this.env.DB.prepare(
          `
          SELECT 1 FROM evaluation_plans
           WHERE event_id = ? AND status = 'active'
             AND decision_role = 'committee_chair'
           LIMIT 1
        `,
        )
          .bind(viewer.eventId)
          .first();
        if (!authority) throw new EvaluationDecisionAuthorityError();
      }
      throw new EvaluationRevisionConflictError(
        "This submission changed before the decision was saved. Refresh before trying again.",
      );
    }
    const webhookDeliveries =
      await webhookService.dispatchPreparedEvent(preparedWebhook);
    if (sessionId)
      await assertAcceptanceTaskPlanMaterialized(this.env, {
        eventId: viewer.eventId,
        submissionId: submission.id,
        sessionId,
        decisionId,
      });
    let notificationStatus: "not_requested" | "queued" | "queue_failed" =
      notificationOperationId ? "queued" : "not_requested";
    if (notificationOperationId) {
      if (!notificationIntent) {
        throw new Error(
          "Released decision notification intent was not materialised.",
        );
      }
      const message: unknown = JSON.parse(notificationIntent.queuePayloadJson);
      try {
        await operationsQueue.send(message);
      } catch (error) {
        notificationStatus = "queue_failed";
        await this.env.DB.prepare(
          "UPDATE operation_jobs SET status = 'queue_failed', last_error = ?, updated_at = unixepoch() WHERE id = ?",
        )
          .bind(
            error instanceof Error ? error.message : String(error),
            notificationOperationId,
          )
          .run();
      }
    }
    let speakerInvitationStatus:
      | "not_required"
      | "queued"
      | "queue_failed"
      | "demo_not_sent"
      | "demo_activation_failed" = "not_required";
    let speakerInvitationCount = speakerInvitations.length;
    if (speakerInvitationCount > 0) {
      if (String(this.env.DEMO_MODE) === "true") {
        const outcome = await acceptedSpeakerInvitationOutcome(
          this.env,
          viewer,
          decisionId,
          sessionId,
        );
        speakerInvitationStatus = outcome.speakerInvitationStatus;
        speakerInvitationCount = outcome.speakerInvitationCount;
      } else {
        speakerInvitationStatus = "queued";
        for (const plan of speakerInvitationPlans) {
          try {
            await operationsQueue.send(plan.message);
          } catch (error) {
            await persistAcceptedSpeakerQueueFailure(this.env, plan, error);
            speakerInvitationStatus = "queue_failed";
          }
        }
      }
    }
    return {
      decisionId,
      sessionId,
      notificationOperationId,
      notificationStatus,
      speakerInvitationStatus,
      speakerInvitationCount,
      webhookDeliveries,
    };
  }
}
