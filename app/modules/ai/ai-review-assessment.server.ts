import {
  decisionAuthorityBindings,
  decisionAuthorityGuardSql,
} from "~/modules/evaluations/evaluation-decision-authority.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  AiReviewAssessmentConflictError,
  AiReviewAssessmentStateError,
} from "./ai-review-assessment-errors";
import { AiReviewAssessmentGenerationService } from "./ai-review-assessment-generation.server";
import {
  epochSeconds,
  overrideInputSchema,
  sha256,
} from "./ai-review-assessment-support.server";

export {
  AiReviewAssessmentConflictError,
  AiReviewAssessmentIntentConflictError,
  AiReviewAssessmentStateError,
} from "./ai-review-assessment-errors";
export type { AiReviewAssessmentGenerationAttempt } from "./ai-review-assessment-reader.server";
export type { AiReviewAssessment } from "./ai-review-assessment-support.server";

/** Assessment façade adding human advisory-assessment behavior to generation. */
export class AiReviewAssessmentService extends AiReviewAssessmentGenerationService {
  async override(viewer: Viewer, rawInput: unknown) {
    await this.assertViewerEvent(viewer);
    const input = overrideInputSchema.parse(rawInput);
    const operationId = `ai-review-override:${crypto.randomUUID()}`;
    const overriddenAt = epochSeconds(this.now());
    const metadata = JSON.stringify({
      assessmentId: input.assessmentId,
      expectedRevision: input.expectedRevision,
      score: input.score,
      rationaleHash: await sha256(input.rationale),
    });
    await this.dependencies.beforeOverridePersisted?.();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE ai_review_assessments AS assessment
          SET override_score = ?, override_rationale = ?,
              override_by_person_id = ?, override_at = ?,
              revision = revision + 1, last_operation_id = ?, updated_at = ?
        WHERE assessment.id = ? AND assessment.event_id = ?
          AND assessment.revision = ?
          AND EXISTS (
            SELECT 1 FROM events event
             WHERE event.id = assessment.event_id
               AND event.organisation_id = ?
               AND event.repository_provider = 'd1'
          )
          AND EXISTS (
            SELECT 1
              FROM evaluation_rounds round
              JOIN evaluation_plans plan
                ON plan.id = round.plan_id
               AND plan.event_id = round.event_id
             WHERE round.id = assessment.round_id
               AND round.event_id = assessment.event_id
               AND round.status IN ('active','closed')
               AND plan.status IN ('active','closed')
               AND NOT EXISTS (
                 SELECT 1 FROM evaluation_plans other_plan
                  WHERE other_plan.event_id = plan.event_id
                    AND other_plan.id <> plan.id
                    AND other_plan.status <> 'archived'
               )
          )
          AND ${decisionAuthorityGuardSql("assessment.event_id")}`,
      ).bind(
        input.score,
        input.rationale,
        viewer.personId,
        overriddenAt,
        operationId,
        overriddenAt,
        input.assessmentId,
        viewer.eventId,
        input.expectedRevision,
        viewer.organisationId,
        ...decisionAuthorityBindings(viewer.role),
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, correlation_id, metadata_json, created_at
       )
       SELECT ?, 'person', 'admin_ui', 1, ?, assessment.event_id, ?,
              'ai.review_assessment.overridden', 'ai_review_assessment',
              assessment.id, ?, ?, ?
         FROM ai_review_assessments assessment
         JOIN events event
           ON event.id = assessment.event_id AND event.organisation_id = ?
          AND event.repository_provider = 'd1'
        WHERE assessment.id = ? AND assessment.event_id = ?
          AND assessment.last_operation_id = ?`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.personId,
        operationId,
        metadata,
        overriddenAt,
        viewer.organisationId,
        input.assessmentId,
        viewer.eventId,
        operationId,
      ),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1
    ) {
      const current = await this.getById(viewer, input.assessmentId);
      if (current) {
        await this.assertViewerEvent(viewer);
        if (current.revision !== input.expectedRevision) {
          throw new AiReviewAssessmentConflictError();
        }
        const authority = await this.env.DB.prepare(
          `SELECT ${decisionAuthorityGuardSql("assessment.event_id")} AS authorised
             FROM ai_review_assessments assessment
             JOIN events event
               ON event.id = assessment.event_id
              AND event.organisation_id = ?
            WHERE assessment.id = ? AND assessment.event_id = ?`,
        )
          .bind(
            ...decisionAuthorityBindings(viewer.role),
            viewer.organisationId,
            input.assessmentId,
            viewer.eventId,
          )
          .first<{ authorised: number | boolean }>();
        if (!authority?.authorised) {
          throw new Response(
            "Only an owner, administrator, or committee chair with current decision authority can assess an AI advisory.",
            { status: 403 },
          );
        }
        throw new AiReviewAssessmentStateError(
          "A human assessment of AI can only be saved in the event's current review cycle.",
        );
      }
      throw new Response("AI review assessment not found.", { status: 404 });
    }
    const saved = await this.getById(viewer, input.assessmentId);
    if (!saved) {
      throw new Error(
        `AI assessment ${input.assessmentId} was overridden but could not be reloaded.`,
      );
    }
    return saved;
  }
}
