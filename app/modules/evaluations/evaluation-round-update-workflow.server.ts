import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
} from "./evaluation-errors";
import { draftRoundUpdateSchema } from "./evaluation-schema";
import {
  EvaluationServiceFoundation,
  persistedRubricSignature,
  rubricSignature,
  type PersistedRubricShape,
} from "./evaluation-service-foundation.server";

import {
  assertEffectiveRoundDateRange,
  hasRunningAiAssessmentForRound,
  requireScorecardSourceRoundId,
} from "./evaluation-round-workflow-support.server";

export class EvaluationRoundUpdateWorkflow extends EvaluationServiceFoundation {
  async updateDraftRound(
    viewer: Viewer,
    input: unknown,
    operation?: { operationId: string; auditId: string },
  ) {
    return this.projectCommand(
      viewer,
      "evaluation.round.update",
      operation ? { operationId: operation.operationId, input } : input,
      undefined,
      () => this.updateDraftRoundD1(viewer, input, operation),
    );
  }

  protected async updateDraftRoundD1(
    viewer: Viewer,
    input: unknown,
    operation?: { operationId: string; auditId: string },
  ) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = draftRoundUpdateSchema.parse(input);
    const currentRound = await this.env.DB.prepare(
      `
      SELECT p.id AS planId, r.status, r.opens_at AS opensAt,
             r.closes_at AS closesAt,
             r.blinded_reviewing AS anonymous, r.scorecard_id AS scorecardId,
             r.scorecard_version AS scorecardVersion
        FROM evaluation_rounds r
        JOIN evaluation_plans p
          ON p.id = r.plan_id AND p.event_id = r.event_id
         AND p.status IN ('draft','active')
        JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
       WHERE r.id = ? AND r.event_id = ?
         AND r.status IN ('draft','active')
         AND NOT EXISTS (
           SELECT 1 FROM evaluator_assignments assignment
            WHERE assignment.event_id = r.event_id
              AND assignment.round_id = r.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM ai_review_assessments assessment
            WHERE assessment.event_id = r.event_id
              AND assessment.round_id = r.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM operation_jobs operation
            WHERE operation.event_id = r.event_id
              AND operation.organisation_id = e.organisation_id
              AND operation.type = 'ai.review_assessment.generate'
              AND operation.status = 'running'
              AND json_type(operation.payload_json, '$.roundId') = 'text'
              AND json_extract(operation.payload_json, '$.roundId') = r.id
         )
    `,
    )
      .bind(viewer.organisationId, parsed.roundId, viewer.eventId)
      .first<{
        planId: string;
        status: "draft" | "active";
        opensAt: number | null;
        closesAt: number | null;
        anonymous: number | boolean;
        scorecardId: string;
        scorecardVersion: number;
      }>();
    if (!currentRound) {
      throw new EvaluationStateError(
        "The evaluation round is not editable. Only draft or active rounds without review, AI-assessment, or running AI-assessment activity can be changed.",
      );
    }
    const currentCriteria = await this.env.DB.prepare(
      `
      SELECT c.id, c.name, c.description, c.input_type AS inputType,
             c.options_json AS optionsJson, c.weight_percent AS weightPercent,
             c.required, c.position
        FROM evaluation_criteria c
        JOIN evaluation_rounds r
          ON r.id = c.round_id AND r.event_id = c.event_id
        JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
       WHERE c.event_id = ? AND c.round_id = ? AND r.plan_id = ?
       ORDER BY c.position
    `,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        parsed.roundId,
        currentRound.planId,
      )
      .all<PersistedRubricShape & { id: string }>();
    if (currentCriteria.results.length === 0) {
      throw new EvaluationStateError(
        "The editable evaluation round has no persisted scorecard rubric.",
      );
    }
    const duplicateRound = await this.env.DB.prepare(
      `
      SELECT r.id
        FROM evaluation_rounds r
        JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
       WHERE r.event_id = ? AND r.plan_id = ? AND r.id <> ?
         AND trim(r.name) = trim(?) COLLATE NOCASE
       LIMIT 1
    `,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        currentRound.planId,
        parsed.roundId,
        parsed.name,
      )
      .first();
    if (duplicateRound) {
      throw new EvaluationStateError(
        "An evaluation round with that name already exists in this plan.",
      );
    }
    const submittedRubricSignature = rubricSignature(parsed.criteria);
    const currentRubricSignature = persistedRubricSignature(
      currentCriteria.results,
    );
    const criteriaChanged = submittedRubricSignature !== currentRubricSignature;
    const currentCriterionIdsByPosition = new Map(
      currentCriteria.results.map((criterion) => [
        criterion.position,
        criterion.id,
      ]),
    );
    if (
      !criteriaChanged &&
      parsed.criteria.some(
        (criterion) =>
          criterion.id !==
          currentCriterionIdsByPosition.get(criterion.position),
      )
    ) {
      throw new EvaluationStateError(
        "Existing criterion identifiers must be preserved when the rubric is unchanged.",
      );
    }
    const requestedScorecardId = parsed.scorecardId ?? currentRound.scorecardId;
    const requestedScorecardVersion =
      parsed.scorecardVersion ?? currentRound.scorecardVersion;
    if (
      !criteriaChanged &&
      (requestedScorecardId !== currentRound.scorecardId ||
        requestedScorecardVersion !== currentRound.scorecardVersion)
    ) {
      const sourceRoundId = await requireScorecardSourceRoundId(
        this.env.DB,
        viewer.organisationId,
        viewer.eventId,
        currentRound.planId,
        requestedScorecardId,
        requestedScorecardVersion,
      );
      const selectedCriteria = await this.env.DB.prepare(
        `
        SELECT c.name, c.description, c.input_type AS inputType,
               c.options_json AS optionsJson, c.weight_percent AS weightPercent,
               c.required, c.position
          FROM evaluation_criteria c
          JOIN evaluation_rounds r
            ON r.id = c.round_id AND r.event_id = c.event_id
          JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
         WHERE c.event_id = ? AND c.round_id = ? AND r.plan_id = ?
         ORDER BY c.position
      `,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          sourceRoundId,
          currentRound.planId,
        )
        .all<PersistedRubricShape>();
      if (
        selectedCriteria.results.length === 0 ||
        persistedRubricSignature(selectedCriteria.results) !==
          submittedRubricSignature
      ) {
        throw new EvaluationStateError(
          "The selected scorecard version is linked to a different rubric. Choose a new scorecard version before saving.",
        );
      }
    }
    const recover = operation
      ? () =>
          this.env.DB.prepare(
            `SELECT round.id
               FROM evaluation_rounds round
               JOIN events event
                 ON event.id = round.event_id AND event.organisation_id = ?
              WHERE round.id = ? AND round.event_id = ?
                AND round.last_operation_id = ?
                AND round.revision = ?
                AND (SELECT COUNT(*) FROM evaluation_criteria criterion
                      WHERE criterion.event_id = round.event_id
                        AND criterion.round_id = round.id) = ?`,
          )
            .bind(
              viewer.organisationId,
              parsed.roundId,
              viewer.eventId,
              operation.operationId,
              parsed.revision + 1,
              parsed.criteria.length,
            )
            .first()
      : null;
    if (await recover?.()) return;
    const operationId = operation?.operationId ?? crypto.randomUUID();
    const opensAt =
      parsed.opensAt !== undefined
        ? parsed.opensAt
        : currentRound.opensAt === null
          ? null
          : new Date(currentRound.opensAt * 1_000).toISOString();
    const closesAtValue =
      parsed.closesAt !== undefined
        ? parsed.closesAt
        : (parsed.dueAt ??
          (currentRound.closesAt === null
            ? null
            : new Date(currentRound.closesAt * 1_000).toISOString()));
    assertEffectiveRoundDateRange(opensAt, closesAtValue);
    const anonymous = parsed.anonymous ?? Boolean(currentRound.anonymous);
    const scorecardId = criteriaChanged ? parsed.roundId : requestedScorecardId;
    const scorecardVersion = criteriaChanged
      ? currentRound.scorecardId === parsed.roundId
        ? currentRound.scorecardVersion + 1
        : 1
      : requestedScorecardVersion;
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ?
           AND EXISTS (
             SELECT 1
               FROM evaluation_rounds editable_round
               JOIN evaluation_plans editable_plan
                 ON editable_plan.id = editable_round.plan_id
                AND editable_plan.event_id = editable_round.event_id
                AND editable_plan.status IN ('draft','active')
              WHERE editable_round.id = ?
                AND editable_round.event_id = events.id
                AND editable_round.status IN ('draft','active')
                AND editable_round.revision = ?
                AND NOT EXISTS (
                  SELECT 1 FROM evaluator_assignments assignment
                   WHERE assignment.event_id = editable_round.event_id
                     AND assignment.round_id = editable_round.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM ai_review_assessments assessment
                   WHERE assessment.event_id = editable_round.event_id
                     AND assessment.round_id = editable_round.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM operation_jobs operation
                   WHERE operation.event_id = editable_round.event_id
                     AND operation.organisation_id = events.organisation_id
                     AND operation.type = 'ai.review_assessment.generate'
                     AND operation.status = 'running'
                     AND json_type(operation.payload_json, '$.roundId') = 'text'
                     AND json_extract(operation.payload_json, '$.roundId') = editable_round.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM evaluation_rounds named_round
                   WHERE named_round.event_id = editable_round.event_id
                     AND named_round.plan_id = editable_round.plan_id
                     AND named_round.id <> editable_round.id
                     AND trim(named_round.name) = trim(?) COLLATE NOCASE
                )
           )
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.roundId,
        parsed.revision,
        parsed.name,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_rounds SET name = ?, opens_at = ?, closes_at = ?,
               blinded_reviewing = ?, scorecard_id = ?, scorecard_version = ?,
               revision = revision + 1, last_operation_id = ?,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND status IN ('draft','active')
           AND NOT EXISTS (
             SELECT 1 FROM evaluator_assignments
              WHERE event_id = ? AND round_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        parsed.name,
        opensAt ? Math.floor(Date.parse(opensAt) / 1_000) : null,
        closesAtValue ? Math.floor(Date.parse(closesAtValue) / 1_000) : null,
        anonymous ? 1 : 0,
        scorecardId,
        scorecardVersion,
        operationId,
        parsed.roundId,
        viewer.eventId,
        parsed.revision,
        viewer.eventId,
        parsed.roundId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_plans SET revision = revision + 1,
               blinded_reviewing = CASE WHEN EXISTS (
                 SELECT 1 FROM evaluation_rounds plan_round
                  WHERE plan_round.plan_id = evaluation_plans.id
                    AND plan_round.event_id = evaluation_plans.event_id
                    AND plan_round.blinded_reviewing = 1
               ) THEN 1 ELSE 0 END,
               updated_at = unixepoch()
         WHERE event_id = ? AND id = (
           SELECT plan_id FROM evaluation_rounds
            WHERE id = ? AND event_id = ? AND revision = ?
         )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        parsed.roundId,
        viewer.eventId,
        parsed.revision + 1,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        DELETE FROM evaluation_criteria
         WHERE event_id = ? AND round_id = ?
           AND EXISTS (
             SELECT 1 FROM evaluation_rounds
              WHERE id = ? AND event_id = ? AND revision = ?
                AND name = ? AND status IN ('draft','active')
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        parsed.roundId,
        parsed.roundId,
        viewer.eventId,
        parsed.revision + 1,
        parsed.name,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    ];
    for (const criterion of parsed.criteria) {
      statements.push(
        this.env.DB.prepare(
          `
          INSERT INTO evaluation_criteria (
            id, event_id, round_id, name, description, input_type,
            options_json, weight_percent, required, position
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM evaluation_rounds
              WHERE id = ? AND event_id = ? AND revision = ?
                AND name = ? AND status IN ('draft','active')
           )
             AND EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
             )
        `,
        ).bind(
          criterion.id,
          viewer.eventId,
          parsed.roundId,
          criterion.name,
          criterion.description || null,
          criterion.inputType,
          JSON.stringify(criterion.options),
          criterion.weightPercent,
          criterion.required ? 1 : 0,
          criterion.position,
          parsed.roundId,
          viewer.eventId,
          parsed.revision + 1,
          parsed.name,
          viewer.eventId,
          viewer.organisationId,
          operationId,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'evaluation.round.updated',
               'evaluation_round', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluation_rounds
            WHERE id = ? AND event_id = ? AND revision = ?
              AND name = ? AND status IN ('draft','active')
         )
           AND (SELECT COUNT(*) FROM evaluation_criteria
                 WHERE event_id = ? AND round_id = ?) = ?
      `,
      ).bind(
        operation?.auditId ?? crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.roundId,
        JSON.stringify({ criterionCount: parsed.criteria.length }),
        parsed.roundId,
        viewer.eventId,
        parsed.revision + 1,
        parsed.name,
        viewer.eventId,
        parsed.roundId,
        parsed.criteria.length,
      ),
    );
    let claimed: D1Result<unknown>;
    try {
      [claimed] = await this.env.DB.batch(statements);
    } catch (error) {
      if (await recover?.()) return;
      throw error;
    }
    if ((claimed.meta.changes ?? 0) !== 1) {
      if (await recover?.()) return;
      if (
        await hasRunningAiAssessmentForRound(
          this.env.DB,
          viewer.organisationId,
          viewer.eventId,
          parsed.roundId,
        )
      ) {
        throw new EvaluationStateError(
          "A running AI review assessment appeared before the round could be updated. Wait for it to finish and try again.",
        );
      }
      throw new EvaluationRevisionConflictError(
        "The evaluation round changed or received review activity before it could be updated.",
      );
    }
  }
}
