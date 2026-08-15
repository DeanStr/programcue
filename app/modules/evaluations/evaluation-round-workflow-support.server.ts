import { EvaluationStateError } from "./evaluation-errors";
import {
  persistedRubricSignature,
  type PersistedRubricShape,
} from "./evaluation-service-foundation.server";

export function assertEffectiveRoundDateRange(
  opensAt: string | null,
  closesAt: string | null,
) {
  if (opensAt && closesAt && Date.parse(closesAt) <= Date.parse(opensAt)) {
    throw new EvaluationStateError(
      "The round close date must be after its open date.",
    );
  }
}

export async function hasRunningAiAssessmentForRound(
  db: D1Database,
  organisationId: string,
  eventId: string,
  roundId: string,
) {
  const row = await db
    .prepare(
      `SELECT EXISTS (
         SELECT 1
           FROM operation_jobs operation
           JOIN events event
             ON event.id = operation.event_id
            AND event.organisation_id = operation.organisation_id
          WHERE operation.organisation_id = ?
            AND operation.event_id = ?
            AND operation.type = 'ai.review_assessment.generate'
            AND operation.status = 'running'
            AND json_type(operation.payload_json, '$.roundId') = 'text'
            AND json_extract(operation.payload_json, '$.roundId') = ?
       ) AS present`,
    )
    .bind(organisationId, eventId, roundId)
    .first<{ present: number | boolean }>();
  return Boolean(row?.present);
}

export async function requireScorecardSourceRoundId(
  db: D1Database,
  organisationId: string,
  eventId: string,
  planId: string,
  scorecardId: string,
  scorecardVersion: number,
) {
  const sourceRounds = await db
    .prepare(
      `
      SELECT r.id AS sourceRoundId
        FROM evaluation_rounds r
        JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
       WHERE r.event_id = ? AND r.plan_id = ?
         AND r.scorecard_id = ? AND r.scorecard_version = ?
       ORDER BY r.id
    `,
    )
    .bind(organisationId, eventId, planId, scorecardId, scorecardVersion)
    .all<{ sourceRoundId: string }>();
  if (sourceRounds.results.length === 0) {
    throw new EvaluationStateError(
      "The selected scorecard is not available in this evaluation plan.",
    );
  }
  if (sourceRounds.results.length > 1) {
    const sourceRoundIds = sourceRounds.results.map(
      (sourceRound) => sourceRound.sourceRoundId,
    );
    const placeholders = sourceRoundIds.map(() => "?").join(",");
    const criteria = await db
      .prepare(
        `
        SELECT c.round_id AS roundId, c.name, c.description,
               c.input_type AS inputType, c.options_json AS optionsJson,
               c.weight_percent AS weightPercent, c.required, c.position
          FROM evaluation_criteria c
          JOIN evaluation_rounds r
            ON r.id = c.round_id AND r.event_id = c.event_id
          JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
         WHERE c.event_id = ? AND r.plan_id = ?
           AND c.round_id IN (${placeholders})
         ORDER BY c.round_id, c.position
      `,
      )
      .bind(organisationId, eventId, planId, ...sourceRoundIds)
      .all<PersistedRubricShape & { roundId: string }>();
    const criteriaByRound = new Map<string, PersistedRubricShape[]>();
    for (const criterion of criteria.results) {
      const roundCriteria = criteriaByRound.get(criterion.roundId) ?? [];
      roundCriteria.push(criterion);
      criteriaByRound.set(criterion.roundId, roundCriteria);
    }
    const signatures = new Set<string>();
    for (const sourceRoundId of sourceRoundIds) {
      const sourceCriteria = criteriaByRound.get(sourceRoundId);
      if (!sourceCriteria || sourceCriteria.length === 0) {
        throw new EvaluationStateError(
          `Scorecard ${scorecardId} version ${scorecardVersion} is missing a persisted rubric.`,
        );
      }
      signatures.add(persistedRubricSignature(sourceCriteria));
    }
    if (signatures.size > 1) {
      throw new EvaluationStateError(
        `Scorecard ${scorecardId} version ${scorecardVersion} is linked to different persisted rubrics. Choose a new scorecard version before saving.`,
      );
    }
  }
  return sourceRounds.results[0]!.sourceRoundId;
}
