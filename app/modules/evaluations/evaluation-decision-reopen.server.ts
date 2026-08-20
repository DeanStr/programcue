import type { Viewer } from "~/platform/auth/authorize.server";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import { assertDecisionViewerEvent } from "./evaluation-decision-acceptance-guard.server";
import {
  EvaluationDecisionAuthorityError,
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";
import { decisionReopenSchema } from "./evaluation-schema";

export type DecisionReopenNotificationOutcome =
  | "cancelled_before_delivery"
  | "already_provider_accepted"
  | "legacy_unverified";

export type DecisionReopenResult = {
  decisionId: string;
  submissionId: string;
  notificationOutcome: DecisionReopenNotificationOutcome;
  communicationStatus: string | null;
  deliveryStatus: string | null;
};

const decisionReopenCancellableJobStatusesSql = `'queued','queue_failed','received','retrying','failed','partially_failed'`;

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

const decisionReopenOneRecipientGraphSql = `
  (
    SELECT COUNT(*) FROM communications communication
     WHERE communication.operation_id = job.id
       AND communication.event_id = job.event_id
  ) = 1
  AND (
    SELECT COUNT(*) FROM communication_deliveries delivery
    JOIN communications communication
      ON communication.id = delivery.communication_id
     AND communication.event_id = delivery.event_id
     AND communication.operation_id = job.id
    WHERE delivery.event_id = job.event_id
  ) = 1
  AND (
    SELECT COUNT(*) FROM operation_items item
     WHERE item.operation_id = job.id
  ) = 1
  AND EXISTS (
    SELECT 1 FROM operation_items item
    JOIN communication_deliveries delivery
      ON delivery.id = item.entity_id
     AND delivery.event_id = job.event_id
    JOIN communications communication
      ON communication.id = delivery.communication_id
     AND communication.event_id = delivery.event_id
     AND communication.operation_id = job.id
    WHERE item.operation_id = job.id
      AND item.entity_type = 'communication_delivery'
  )`;

const decisionReopenNotificationGraphIntactSql = `
  (
    (
      ? IS NULL
      AND ${decisionReopenLegacyUnlinkedSql}
    )
    OR EXISTS (
      SELECT 1 FROM operation_jobs job
       WHERE job.id = ?
         AND job.event_id = ?
         AND job.organisation_id = ?
         AND job.type = 'decision.notification'
         AND ${decisionReopenOneRecipientGraphSql}
         AND (
           (
             job.status = 'cancelled'
             AND EXISTS (
               SELECT 1 FROM communications communication
                WHERE communication.operation_id = job.id
                  AND communication.event_id = job.event_id
                  AND communication.status = 'cancelled'
             )
             AND EXISTS (
               SELECT 1 FROM communication_deliveries delivery
               JOIN communications communication
                 ON communication.id = delivery.communication_id
                AND communication.event_id = delivery.event_id
                AND communication.operation_id = job.id
               WHERE delivery.event_id = job.event_id
                 AND delivery.status = 'cancelled'
             )
             AND EXISTS (
               SELECT 1 FROM operation_items item
               JOIN communication_deliveries delivery
                 ON delivery.id = item.entity_id
                AND delivery.event_id = job.event_id
               WHERE item.operation_id = job.id
                 AND item.entity_type = 'communication_delivery'
                 AND item.status = 'skipped'
             )
           )
           OR (
             job.status = 'completed'
             AND EXISTS (
               SELECT 1 FROM communications communication
                WHERE communication.operation_id = job.id
                  AND communication.event_id = job.event_id
                  AND communication.status IN ('sent','partially_failed','failed')
             )
             AND EXISTS (
               SELECT 1 FROM communication_deliveries delivery
               JOIN communications communication
                 ON communication.id = delivery.communication_id
                AND communication.event_id = delivery.event_id
                AND communication.operation_id = job.id
               WHERE delivery.event_id = job.event_id
                 AND delivery.status IN (
                   'sent','delivered','opened','clicked','bounced','suppressed','failed'
                 )
             )
             AND EXISTS (
               SELECT 1 FROM operation_items item
               JOIN communication_deliveries delivery
                 ON delivery.id = item.entity_id
                AND delivery.event_id = job.event_id
               WHERE item.operation_id = job.id
                 AND item.entity_type = 'communication_delivery'
                 AND item.status = 'completed'
             )
           )
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
    eventId,
    organisationId,
  ] as const;
}

export class EvaluationDecisionReopenWorkflow {
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
    const [
      auditInsert,
      ,
      ,
      ,
      ,
      decisionUpdate,
      submissionUpdate,
      eventChange,
      ,
      evidenceSelect,
    ] = await this.env.DB.batch([
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
              )
              AND EXISTS (
                SELECT 1 FROM operation_jobs cancellable_notification
                 WHERE cancellable_notification.id = communications.operation_id
                   AND cancellable_notification.event_id = communications.event_id
                   AND cancellable_notification.organisation_id = ?
                   AND cancellable_notification.type = 'decision.notification'
                   AND cancellable_notification.status IN (
                     ${decisionReopenCancellableJobStatusesSql}
                   )
                   AND cancellable_notification.claim_token IS NULL
              )`,
      ).bind(
        released.notificationOperationId,
        viewer.eventId,
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
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
              )
              AND EXISTS (
                SELECT 1 FROM operation_jobs cancellable_notification
                JOIN communications communication
                  ON communication.operation_id = cancellable_notification.id
                 AND communication.event_id = cancellable_notification.event_id
                 AND communication.id = communication_deliveries.communication_id
               WHERE cancellable_notification.id = ?
                 AND cancellable_notification.event_id = communication_deliveries.event_id
                 AND cancellable_notification.organisation_id = ?
                 AND cancellable_notification.type = 'decision.notification'
                 AND cancellable_notification.status IN (
                   ${decisionReopenCancellableJobStatusesSql}
                 )
                 AND cancellable_notification.claim_token IS NULL
              )`,
      ).bind(
        viewer.eventId,
        released.notificationOperationId,
        released.notificationOperationId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE operation_items
              SET status = 'skipped', error_code = 'DECISION_REOPENED',
                  error_message = 'The original decision was reopened before delivery.',
                  completed_at = unixepoch(), updated_at = unixepoch()
            WHERE operation_id = ? AND status IN ('pending','failed')
              AND EXISTS (
                SELECT 1 FROM audit_events
                 WHERE id = ? AND organisation_id = ? AND event_id = ?
              )
              AND EXISTS (
                SELECT 1 FROM operation_jobs cancellable_notification
                 WHERE cancellable_notification.id = operation_items.operation_id
                   AND cancellable_notification.event_id = ?
                   AND cancellable_notification.organisation_id = ?
                   AND cancellable_notification.type = 'decision.notification'
                   AND cancellable_notification.status IN (
                     ${decisionReopenCancellableJobStatusesSql}
                   )
                   AND cancellable_notification.claim_token IS NULL
              )`,
      ).bind(
        released.notificationOperationId,
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.eventId,
        viewer.organisationId,
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
      this.env.DB.prepare(
        `SELECT CASE
                    WHEN ? IS NULL THEN 'legacy_unverified'
                    WHEN job.status = 'cancelled' THEN 'cancelled_before_delivery'
                    WHEN job.status = 'completed' THEN 'already_provider_accepted'
                  END AS notificationOutcome,
                  job.status AS operationStatus,
                  communication.status AS communicationStatus,
                  delivery.status AS deliveryStatus
             FROM (SELECT 1 AS present) seed
             LEFT JOIN operation_jobs job
               ON job.id = ?
              AND job.event_id = ?
              AND job.organisation_id = ?
              AND job.type = 'decision.notification'
             LEFT JOIN communications communication
               ON communication.operation_id = job.id
              AND communication.event_id = job.event_id
             LEFT JOIN communication_deliveries delivery
               ON delivery.communication_id = communication.id
              AND delivery.event_id = communication.event_id
            WHERE (
              ? IS NULL
              AND ${decisionReopenLegacyUnlinkedSql}
            ) OR (
              ? IS NOT NULL
              AND job.id IS NOT NULL
            )`,
      ).bind(
        released.notificationOperationId,
        released.notificationOperationId,
        viewer.eventId,
        viewer.organisationId,
        released.notificationOperationId,
        ...decisionReopenLegacyUnlinkedBindings(
          released.decisionId,
          viewer.organisationId,
          viewer.eventId,
        ),
        released.notificationOperationId,
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
    const evidence = evidenceSelect.results[0] as
      | {
          notificationOutcome: DecisionReopenNotificationOutcome | null;
          communicationStatus: string | null;
          deliveryStatus: string | null;
        }
      | undefined;
    if (
      evidence?.notificationOutcome !== "cancelled_before_delivery" &&
      evidence?.notificationOutcome !== "already_provider_accepted" &&
      evidence?.notificationOutcome !== "legacy_unverified"
    ) {
      throw new Error(
        "The reopened decision left its notification graph in an unexpected state.",
      );
    }
    return {
      decisionId: released.decisionId,
      submissionId: parsed.submissionId,
      notificationOutcome: evidence.notificationOutcome,
      communicationStatus: evidence.communicationStatus,
      deliveryStatus: evidence.deliveryStatus,
    };
  }
}
