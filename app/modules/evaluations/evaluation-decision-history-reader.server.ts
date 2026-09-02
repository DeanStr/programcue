import { requireValue } from "~/lib/required-value";

export async function loadEvaluationDecisionHistory(input: {
  env: CloudflareEnvironment;
  organisationId: string;
  eventId: string;
  resultsRoundId: string | null;
}) {
  const { env, organisationId, eventId, resultsRoundId } = input;
  const rawDecisionHistoryRows = resultsRoundId
    ? await env.DB.prepare(
        `SELECT decision.id, decision.submission_id AS submissionId,
                decision.revision_number AS revisionNumber,
                decision.status, decision.decision, decision.rationale,
                decision.decided_at AS decidedAt,
                decision.published_at AS publishedAt,
                person.display_name AS decidedByName,
                decision.notification_operation_id AS notificationOperationId,
                EXISTS (
                  SELECT 1
                    FROM audit_events legacy_unlinked
                   WHERE legacy_unlinked.id =
                         'migration-0041-decision-notification-unlinked:' || decision.id
                     AND legacy_unlinked.organisation_id = event.organisation_id
                     AND legacy_unlinked.event_id = decision.event_id
                     AND legacy_unlinked.actor_kind = 'system'
                     AND legacy_unlinked.origin = 'internal'
                     AND legacy_unlinked.action =
                         'decision.notification.legacy_unlinked'
                     AND legacy_unlinked.entity_type = 'submission_decision'
                     AND legacy_unlinked.entity_id = decision.id
                ) AS hasLegacyUnlinkedMarker,
                operation.id AS notificationOperationRecordId,
                operation.status AS notificationOperationStatus,
                operation.last_error AS notificationOperationError,
                communication.id AS communicationId,
                communication.status AS communicationStatus,
                delivery.id AS deliveryId,
                delivery.status AS deliveryStatus,
                delivery.recipient_address AS recipientAddress,
                delivery.recipient_name AS recipientName,
                delivery.provider AS deliveryProvider,
                delivery.rendered_subject AS renderedSubject,
                delivery.rendered_body_sha256 AS renderedBodySha256,
                delivery.provider_message_id AS providerMessageId,
                delivery.failure_code AS failureCode,
                delivery.failure_message AS failureMessage,
                delivery.updated_at AS deliveryUpdatedAt,
                json_extract(communication.audience_json, '$.decisionId')
                  AS audienceDecisionId,
                json_extract(communication.audience_json, '$.submissionId')
                  AS audienceSubmissionId,
                delivery.source_id AS deliverySourceId,
                json_extract(communication.content_snapshot_json, '$.template.id')
                  AS templateVersionId,
                json_extract(communication.content_snapshot_json, '$.template.name')
                  AS templateName,
                json_extract(communication.content_snapshot_json, '$.template.versionNumber')
                  AS templateVersionNumber,
                json_extract(communication.content_snapshot_json, '$.sender.id')
                  AS senderProfileId,
                json_extract(communication.content_snapshot_json, '$.sender.fromName')
                  AS senderFromName,
                json_extract(communication.content_snapshot_json, '$.sender.fromEmail')
                  AS senderFromEmail,
                event.participant_retention_completed_at
                  AS participantRetentionCompletedAt
           FROM submission_decisions decision
           JOIN events event
             ON event.id = decision.event_id AND event.organisation_id = ?
           JOIN people person ON person.id = decision.decided_by_person_id
           LEFT JOIN operation_jobs operation
             ON operation.id = decision.notification_operation_id
            AND operation.event_id = decision.event_id
            AND operation.type = 'decision.notification'
           LEFT JOIN communications communication
             ON communication.operation_id = operation.id
            AND communication.event_id = decision.event_id
           LEFT JOIN communication_deliveries delivery
             ON delivery.communication_id = communication.id
            AND delivery.event_id = decision.event_id
          WHERE decision.event_id = ?
            AND (decision.round_id = ? OR decision.round_id IS NULL)
          ORDER BY decision.submission_id, decision.revision_number DESC`,
      )
        .bind(organisationId, eventId, resultsRoundId)
        .all<{
          id: string;
          submissionId: string;
          revisionNumber: number;
          status: string;
          decision: string;
          rationale: string | null;
          decidedAt: number;
          publishedAt: number | null;
          decidedByName: string;
          notificationOperationId: string | null;
          hasLegacyUnlinkedMarker: number;
          notificationOperationRecordId: string | null;
          notificationOperationStatus: string | null;
          notificationOperationError: string | null;
          communicationId: string | null;
          communicationStatus: string | null;
          deliveryId: string | null;
          deliveryStatus: string | null;
          recipientAddress: string | null;
          recipientName: string | null;
          deliveryProvider: string | null;
          renderedSubject: string | null;
          renderedBodySha256: string | null;
          providerMessageId: string | null;
          failureCode: string | null;
          failureMessage: string | null;
          deliveryUpdatedAt: number | null;
          audienceDecisionId: string | null;
          audienceSubmissionId: string | null;
          deliverySourceId: string | null;
          templateVersionId: string | null;
          templateName: string | null;
          templateVersionNumber: number | null;
          senderProfileId: string | null;
          senderFromName: string | null;
          senderFromEmail: string | null;
          participantRetentionCompletedAt: number | null;
        }>()
    : { results: [] };
  const releasedDecisionRowCounts = new Map<string, number>();
  for (const row of rawDecisionHistoryRows.results) {
    if (
      row.publishedAt === null ||
      !["published", "superseded", "revoked"].includes(row.status)
    ) {
      continue;
    }
    releasedDecisionRowCounts.set(
      row.id,
      (releasedDecisionRowCounts.get(row.id) ?? 0) + 1,
    );
  }
  const duplicatedDecisionEvidence = [...releasedDecisionRowCounts].find(
    ([, count]) => count !== 1,
  );
  if (duplicatedDecisionEvidence) {
    throw new Error(
      `Released decision ${duplicatedDecisionEvidence[0]} has an invalid number of notification evidence rows.`,
    );
  }
  const decisionHistoryRows = {
    results: rawDecisionHistoryRows.results.map((row) => {
      if (
        row.publishedAt === null ||
        !["published", "superseded", "revoked"].includes(row.status)
      ) {
        return { ...row, notificationEvidenceState: "not_applicable" as const };
      }
      const evidencePrefix = `Released decision ${row.id} has incomplete notification evidence`;
      if (row.notificationOperationId === null) {
        if (row.hasLegacyUnlinkedMarker !== 1) {
          throw new Error(
            `${evidencePrefix}: operation link is missing without the migration audit marker.`,
          );
        }
        return { ...row, notificationEvidenceState: "legacy" as const };
      }
      requireValue(
        row.notificationOperationRecordId,
        `${evidencePrefix}: operation record is missing.`,
      );
      const notificationOperationStatus = requireValue(
        row.notificationOperationStatus,
        `${evidencePrefix}: operation status is missing.`,
      );
      const communicationId = requireValue(
        row.communicationId,
        `${evidencePrefix}: communication is missing.`,
      );
      const communicationStatus = requireValue(
        row.communicationStatus,
        `${evidencePrefix}: communication status is missing.`,
      );
      const deliveryId = requireValue(
        row.deliveryId,
        `${evidencePrefix}: recipient delivery is missing.`,
      );
      const deliveryStatus = requireValue(
        row.deliveryStatus,
        `${evidencePrefix}: recipient delivery status is missing.`,
      );
      const deliveryUpdatedAt = requireValue(
        row.deliveryUpdatedAt,
        `${evidencePrefix}: recipient delivery state timestamp is missing.`,
      );
      if (row.participantRetentionCompletedAt !== null) {
        return {
          ...row,
          notificationOperationId: row.notificationOperationId,
          notificationOperationStatus,
          communicationId,
          communicationStatus,
          deliveryId,
          deliveryStatus,
          deliveryUpdatedAt,
          notificationEvidenceState: "retained" as const,
        };
      }
      if (
        row.audienceDecisionId !== row.id ||
        row.audienceSubmissionId !== row.submissionId
      ) {
        throw new Error(
          `${evidencePrefix}: communication audience does not match the released decision.`,
        );
      }
      if (row.deliverySourceId !== row.submissionId) {
        throw new Error(
          `${evidencePrefix}: recipient delivery source does not match the released submission.`,
        );
      }
      const recipientAddress = requireValue(
        row.recipientAddress,
        `${evidencePrefix}: recipient address is missing.`,
      );
      const recipientName = requireValue(
        row.recipientName,
        `${evidencePrefix}: recipient name is missing.`,
      );
      const deliveryProvider = requireValue(
        row.deliveryProvider,
        `${evidencePrefix}: provider is missing.`,
      );
      const renderedSubject = requireValue(
        row.renderedSubject,
        `${evidencePrefix}: rendered subject is missing.`,
      );
      const renderedBodySha256 = requireValue(
        row.renderedBodySha256,
        `${evidencePrefix}: message integrity evidence is missing.`,
      );
      if (!/^[0-9a-f]{64}$/.test(renderedBodySha256)) {
        throw new Error(
          `${evidencePrefix}: message integrity evidence is invalid.`,
        );
      }
      const templateVersionId = requireValue(
        row.templateVersionId,
        `${evidencePrefix}: template version is missing.`,
      );
      const templateName = requireValue(
        row.templateName,
        `${evidencePrefix}: template name is missing.`,
      );
      const templateVersionNumber = requireValue(
        row.templateVersionNumber,
        `${evidencePrefix}: template version number is missing.`,
      );
      const senderProfileId = requireValue(
        row.senderProfileId,
        `${evidencePrefix}: sender profile is missing.`,
      );
      const senderFromName = requireValue(
        row.senderFromName,
        `${evidencePrefix}: sender name is missing.`,
      );
      const senderFromEmail = requireValue(
        row.senderFromEmail,
        `${evidencePrefix}: sender address is missing.`,
      );
      return {
        ...row,
        notificationOperationId: row.notificationOperationId,
        notificationOperationStatus,
        communicationId,
        communicationStatus,
        deliveryId,
        deliveryStatus,
        deliveryUpdatedAt,
        recipientAddress,
        recipientName,
        deliveryProvider,
        renderedSubject,
        renderedBodySha256,
        templateVersionId,
        templateName,
        templateVersionNumber,
        senderProfileId,
        senderFromName,
        senderFromEmail,
        notificationEvidenceState: "available" as const,
      };
    }),
  };

  return decisionHistoryRows;
}
