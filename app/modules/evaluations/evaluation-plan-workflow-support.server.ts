import { z } from "zod";
import { EvaluationStateError } from "./evaluation-errors";
import {
  persistedRubricSignature,
  rubricSignature,
  type PersistedRubricShape,
  type RubricShape,
} from "./evaluation-service-foundation.server";

export const reviewerReminderSchema = z
  .object({
    roundId: z.string().trim().min(1).max(80),
    reviewerPersonIds: z
      .array(z.string().trim().min(1).max(120))
      .min(1, "Select at least one reviewer.")
      .max(100, "Prepare reminders for at most 100 reviewers at a time."),
    templateVersionId: z.string().trim().min(1).max(120),
  })
  .superRefine((input, context) => {
    if (
      new Set(input.reviewerPersonIds).size !== input.reviewerPersonIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["reviewerPersonIds"],
        message: "Reviewer selections must not contain duplicates.",
      });
    }
  });

export async function assertPersistedScorecardConsistency(
  db: D1Database,
  organisationId: string,
  eventId: string,
  planId: string,
  rounds: ReadonlyArray<{
    id: string;
    scorecardId?: string;
    scorecardVersion: number;
    criteria: readonly RubricShape[];
  }>,
) {
  const persisted = await db
    .prepare(
      `
      SELECT r.id AS roundId, r.scorecard_id AS scorecardId,
             r.scorecard_version AS scorecardVersion,
             c.name, c.description, c.input_type AS inputType,
             c.options_json AS optionsJson, c.weight_percent AS weightPercent,
             c.required, c.position
        FROM evaluation_rounds r
        JOIN evaluation_criteria c
          ON c.round_id = r.id AND c.event_id = r.event_id
        JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
       WHERE r.id IN (
         SELECT id FROM evaluation_rounds
          WHERE plan_id = ? AND event_id = ?
       )
       ORDER BY r.id, c.position
    `,
    )
    .bind(organisationId, planId, eventId)
    .all<
      PersistedRubricShape & {
        roundId: string;
        scorecardId: string;
        scorecardVersion: number;
      }
    >();
  const persistedByRound = new Map<
    string,
    {
      key: string;
      criteria: PersistedRubricShape[];
    }
  >();
  for (const criterion of persisted.results) {
    const key = `${criterion.scorecardId}:${criterion.scorecardVersion}`;
    const round = persistedByRound.get(criterion.roundId) ?? {
      key,
      criteria: [],
    };
    round.criteria.push(criterion);
    persistedByRound.set(criterion.roundId, round);
  }
  const signatures = new Map<string, string>();
  for (const { key, criteria } of persistedByRound.values()) {
    const signature = persistedRubricSignature(criteria);
    const previous = signatures.get(key);
    if (previous && previous !== signature) {
      throw new EvaluationStateError(
        `Scorecard ${key.replace(":", " version ")} is already linked to different persisted rubrics. Choose a new scorecard version before saving.`,
      );
    }
    signatures.set(key, signature);
  }
  const persistedRoundIds = new Set(persistedByRound.keys());
  const persistedRoundRows = await db
    .prepare(
      `
      SELECT r.id
        FROM evaluation_rounds r
        JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
       WHERE r.plan_id = ? AND r.event_id = ?
    `,
    )
    .bind(organisationId, planId, eventId)
    .all<{ id: string }>();
  for (const round of persistedRoundRows.results) {
    if (!persistedRoundIds.has(round.id)) {
      throw new EvaluationStateError(
        `Evaluation round ${round.id} is missing its persisted scorecard rubric.`,
      );
    }
  }
  for (const round of rounds) {
    const key = `${round.scorecardId ?? round.id}:${round.scorecardVersion}`;
    const previous = signatures.get(key);
    if (previous && previous !== rubricSignature(round.criteria)) {
      throw new EvaluationStateError(
        `Scorecard ${key.replace(":", " version ")} is already linked to a different persisted rubric. Choose a new scorecard version before saving.`,
      );
    }
  }
}
