import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ReviewerAiSuggestionStateError } from "./reviewer-ai-suggestion-errors";
import { ReviewerAiSuggestionGenerationService } from "./reviewer-ai-suggestion-generation.server";
import {
  invariantGuardStatement,
  isInvariantGuardError,
} from "./reviewer-ai-suggestion-support.server";

export { ReviewerAiSuggestionStateError } from "./reviewer-ai-suggestion-errors";
export type {
  ReviewerAiCriterionSuggestion,
  ReviewerAiSuggestion,
  ReviewerAiSuggestionRetry,
} from "./reviewer-ai-suggestion-support.server";

export class ReviewerAiSuggestionService extends ReviewerAiSuggestionGenerationService {
  async dismiss(viewer: Viewer, rawSuggestionId: unknown) {
    const suggestionId = z
      .string()
      .trim()
      .min(1)
      .max(200)
      .parse(rawSuggestionId);
    const operationId = crypto.randomUUID();
    const dismissedAuditEventId = crypto.randomUUID();
    const [dismissed, audited] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE reviewer_ai_suggestions AS suggestion
            SET status = 'dismissed', dismissed_at = unixepoch(),
                lifecycle_operation_id = ?
          WHERE suggestion.id = ? AND suggestion.event_id = ?
            AND suggestion.evaluator_person_id = ? AND suggestion.status = 'offered'
            AND EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = suggestion.event_id AND event.organisation_id = ?
                 AND event.repository_provider = 'd1'
            )`,
      ).bind(
        operationId,
        suggestionId,
        viewer.eventId,
        viewer.personId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, correlation_id,
           metadata_json, created_at
         )
         SELECT ?, 'person', 'participant_ui', 1, ?, ?, ?,
                'ai.reviewer_suggestion.dismissed', 'reviewer_ai_suggestion',
                suggestion.id, ?, '{}', unixepoch()
           FROM reviewer_ai_suggestions suggestion
          WHERE suggestion.id = ? AND suggestion.event_id = ?
            AND suggestion.evaluator_person_id = ?
            AND suggestion.status = 'dismissed'
            AND suggestion.lifecycle_operation_id = ?`,
      ).bind(
        dismissedAuditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        suggestionId,
        viewer.eventId,
        viewer.personId,
        operationId,
      ),
      invariantGuardStatement(
        this.env,
        `EXISTS (
           SELECT 1 FROM reviewer_ai_suggestions suggestion
            WHERE suggestion.id = ? AND suggestion.event_id = ?
              AND suggestion.status = 'dismissed'
              AND suggestion.lifecycle_operation_id = ?
         ) <> EXISTS (
           SELECT 1 FROM audit_events audit
            WHERE audit.id = ? AND audit.event_id = ?
              AND audit.action = 'ai.reviewer_suggestion.dismissed'
              AND audit.entity_id = ? AND audit.correlation_id = ?
         )`,
        [
          suggestionId,
          viewer.eventId,
          operationId,
          dismissedAuditEventId,
          viewer.eventId,
          suggestionId,
          operationId,
        ],
      ),
    ]).catch((error: unknown) => {
      if (isInvariantGuardError(error)) {
        throw new Error(
          "The reviewer AI dismissal could not record its audit evidence.",
          { cause: error },
        );
      }
      throw error;
    });
    if (
      (dismissed.meta.changes ?? 0) !== 1 ||
      (audited.meta.changes ?? 0) !== 1
    ) {
      throw new ReviewerAiSuggestionStateError(
        "This AI suggestion is no longer available to dismiss.",
      );
    }
  }
}
