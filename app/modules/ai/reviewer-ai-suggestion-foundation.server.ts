import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ReviewerAiSuggestionStateError } from "./reviewer-ai-suggestion-errors";
import {
  invariantGuardStatement,
  isInvariantGuardError,
  parseSuggestions,
  type ReviewerAiSuggestion,
  type SuggestionDependencies,
} from "./reviewer-ai-suggestion-support.server";

export class ReviewerAiSuggestionFoundation {
  constructor(
    protected readonly env: CloudflareEnvironment,
    protected readonly dependencies: SuggestionDependencies = {},
  ) {}

  async setting(viewer: Viewer) {
    const row = await this.env.DB.prepare(
      `SELECT setting.enabled, setting.revision,
              event.repository_provider AS repositoryProvider
         FROM events event
         LEFT JOIN event_ai_review_settings setting ON setting.event_id = event.id
        WHERE event.id = ? AND event.organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{
        enabled: number | boolean | null;
        revision: number | null;
        repositoryProvider: string;
      }>();
    if (!row)
      throw new Response("This event could not be found.", { status: 404 });
    const supported = row.repositoryProvider === "d1";
    return {
      enabled: supported && Boolean(row.enabled),
      revision: row.revision ?? 0,
      supported,
    };
  }

  async updateSetting(viewer: Viewer, input: unknown) {
    if (viewer.role !== "owner" && viewer.role !== "administrator") {
      throw new Response("Reviewer AI settings are not authorised.", {
        status: 403,
      });
    }
    if (!(await this.setting(viewer)).supported) {
      throw new ReviewerAiSuggestionStateError(
        "Reviewer AI suggestions require Program Cue to be this event's authoritative repository.",
      );
    }
    const parsed = z
      .object({
        enabled: z.boolean(),
        revision: z.coerce.number().int().min(0),
      })
      .parse(input);
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const mutation =
      parsed.revision === 0
        ? this.env.DB.prepare(
            `INSERT INTO event_ai_review_settings (
               event_id, enabled, revision, updated_by_person_id,
               last_operation_id, created_at, updated_at
             )
             SELECT event.id, ?, 1, ?, ?, unixepoch(), unixepoch()
               FROM events event
              WHERE event.id = ? AND event.organisation_id = ?
                AND event.repository_provider = 'd1'
                AND NOT EXISTS (
                  SELECT 1 FROM event_ai_review_settings setting
                   WHERE setting.event_id = event.id
                )`,
          ).bind(
            parsed.enabled ? 1 : 0,
            viewer.personId,
            operationId,
            viewer.eventId,
            viewer.organisationId,
          )
        : this.env.DB.prepare(
            `UPDATE event_ai_review_settings AS setting
                SET enabled = ?, revision = revision + 1,
                    updated_by_person_id = ?, last_operation_id = ?,
                    updated_at = unixepoch()
              WHERE setting.event_id = ? AND setting.revision = ?
                AND EXISTS (
                  SELECT 1 FROM events event
                   WHERE event.id = setting.event_id
                     AND event.organisation_id = ?
                     AND event.repository_provider = 'd1'
                )`,
          ).bind(
            parsed.enabled ? 1 : 0,
            viewer.personId,
            operationId,
            viewer.eventId,
            parsed.revision,
            viewer.organisationId,
          );
    const [updated, audited] = await this.env.DB.batch([
      mutation,
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, correlation_id,
           metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, event.organisation_id, setting.event_id,
                ?, 'evaluation.reviewer_ai_setting.updated', 'event',
                setting.event_id, ?, ?, unixepoch()
           FROM event_ai_review_settings setting
           JOIN events event ON event.id = setting.event_id
          WHERE setting.event_id = ? AND event.organisation_id = ?
            AND event.repository_provider = 'd1'
            AND setting.enabled = ? AND setting.revision = ?
            AND setting.last_operation_id = ?`,
      ).bind(
        auditEventId,
        viewer.personId,
        operationId,
        JSON.stringify({
          enabled: parsed.enabled,
          revision: parsed.revision + 1,
        }),
        viewer.eventId,
        viewer.organisationId,
        parsed.enabled ? 1 : 0,
        parsed.revision + 1,
        operationId,
      ),
      invariantGuardStatement(
        this.env,
        `EXISTS (
           SELECT 1 FROM event_ai_review_settings setting
            WHERE setting.event_id = ? AND setting.last_operation_id = ?
         ) <> EXISTS (
           SELECT 1 FROM audit_events audit
            WHERE audit.id = ? AND audit.event_id = ?
              AND audit.action = 'evaluation.reviewer_ai_setting.updated'
              AND audit.correlation_id = ?
         )`,
        [
          viewer.eventId,
          operationId,
          auditEventId,
          viewer.eventId,
          operationId,
        ],
      ),
    ]).catch((error: unknown) => {
      if (isInvariantGuardError(error)) {
        throw new Error(
          "The reviewer AI setting could not record its audit evidence.",
          { cause: error },
        );
      }
      throw error;
    });
    const updatedCount = updated.meta.changes ?? 0;
    const auditedCount = audited.meta.changes ?? 0;
    if (updatedCount !== 1 || auditedCount !== 1) {
      throw new ReviewerAiSuggestionStateError(
        "Reviewer AI settings changed in another session. Refresh before saving.",
      );
    }
    return { enabled: parsed.enabled, revision: parsed.revision + 1 };
  }

  async getForAssignment(viewer: Viewer, assignmentId: string) {
    const row = await this.env.DB.prepare(
      `SELECT suggestion.id, suggestion.assignment_id AS assignmentId,
              suggestion.status, suggestion.suggestions_json AS suggestionsJson,
              suggestion.provider, suggestion.model,
              suggestion.provider_response_id AS providerResponseId,
              suggestion.generated_at AS generatedAt,
              suggestion.assignment_revision AS suggestionAssignmentRevision,
              assignment.revision AS currentAssignmentRevision
         FROM reviewer_ai_suggestions suggestion
         JOIN evaluator_assignments assignment
           ON assignment.id = suggestion.assignment_id
          AND assignment.event_id = suggestion.event_id
         JOIN events event
           ON event.id = suggestion.event_id AND event.organisation_id = ?
          AND event.repository_provider = 'd1'
        WHERE suggestion.event_id = ? AND suggestion.assignment_id = ?
          AND suggestion.evaluator_person_id = ?
          AND assignment.evaluator_person_id = suggestion.evaluator_person_id
          AND suggestion.status IN ('offered','imported')
        ORDER BY suggestion.generated_at DESC, suggestion.id DESC LIMIT 1`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        assignmentId,
        viewer.personId,
      )
      .first<
        Omit<ReviewerAiSuggestion, "suggestions" | "stale"> & {
          suggestionsJson: string;
          suggestionAssignmentRevision: number;
          currentAssignmentRevision: number;
        }
      >();
    if (!row) return null;
    const {
      suggestionsJson,
      suggestionAssignmentRevision,
      currentAssignmentRevision,
      ...suggestion
    } = row;
    return {
      ...suggestion,
      suggestions: parseSuggestions(suggestionsJson, suggestion.id),
      stale:
        suggestion.status === "offered" &&
        suggestionAssignmentRevision !== currentAssignmentRevision,
    } satisfies ReviewerAiSuggestion;
  }
}
