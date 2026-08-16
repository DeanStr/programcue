const submissionAliases = [
  "target",
  "current_target",
  "s",
  "submission",
  "active_submission",
] as const;

type SubmissionAlias = (typeof submissionAliases)[number];
type ReviewEligibilityPhase = "assignment" | "review";

/**
 * A terminal submission may enter a later review cycle only when its published
 * decision has exact provenance in a fully archived evaluation plan and round.
 * An unpublished decision-ready submission becomes assignable only after all
 * of its prior assignments belong to archived plans. Decisions without round
 * provenance deliberately fail closed.
 */
export function reviewableSubmissionSql(
  alias: SubmissionAlias,
  phase: ReviewEligibilityPhase = "assignment",
  allowCurrentAssignmentOperation = false,
) {
  const regularStatuses =
    phase === "assignment"
      ? "'submitted','assigned','in_review'"
      : "'submitted','assigned','in_review','decision_ready'";
  const recycledDecisionReady =
    phase === "assignment"
      ? `
    OR (
      ${alias}.status = 'decision_ready'
      AND NOT EXISTS (
        SELECT 1
          FROM evaluator_assignments current_cycle_assignment
          JOIN evaluation_rounds current_cycle_round
            ON current_cycle_round.id = current_cycle_assignment.round_id
           AND current_cycle_round.event_id = current_cycle_assignment.event_id
          JOIN evaluation_plans current_cycle_plan
            ON current_cycle_plan.id = current_cycle_round.plan_id
           AND current_cycle_plan.event_id = current_cycle_round.event_id
         WHERE current_cycle_assignment.event_id = ${alias}.event_id
           AND current_cycle_assignment.submission_id = ${alias}.id
           AND current_cycle_plan.status <> 'archived'
           ${
             allowCurrentAssignmentOperation
               ? `AND (
             current_cycle_assignment.last_operation_id IS NULL
             OR current_cycle_assignment.last_operation_id <> ?
           )`
               : ""
}
      )
    )`
      : "";
  return `(
    ${alias}.status IN (${regularStatuses})
    ${recycledDecisionReady}
    OR (
      ${alias}.status IN ('accepted','waitlisted','rejected')
      AND EXISTS (
        SELECT 1
          FROM submission_decisions prior_decision
          JOIN evaluation_rounds prior_decision_round
            ON prior_decision_round.id = prior_decision.round_id
           AND prior_decision_round.event_id = prior_decision.event_id
          JOIN evaluation_plans prior_decision_plan
            ON prior_decision_plan.id = prior_decision_round.plan_id
           AND prior_decision_plan.event_id = prior_decision_round.event_id
         WHERE prior_decision.event_id = ${alias}.event_id
           AND prior_decision.submission_id = ${alias}.id
           AND prior_decision.status = 'published'
           AND prior_decision.decision = ${alias}.status
           AND prior_decision_round.status = 'archived'
           AND prior_decision_plan.status = 'archived'
      )
    )
  )`;
}
