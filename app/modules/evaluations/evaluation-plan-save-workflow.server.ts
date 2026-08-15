import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
} from "./evaluation-errors";
import { evaluationPlanSchema } from "./evaluation-schema";
import {
  EvaluationServiceFoundation,
  assertPlanScorecardConsistency,
  evaluationAuditActor,
  planCommandResultSchema,
  type EvaluationAdminActor,
  type EvaluationApiCommand,
} from "./evaluation-service-foundation.server";

import { assertPersistedScorecardConsistency } from "./evaluation-plan-workflow-support.server";

export class EvaluationPlanSaveWorkflow extends EvaluationServiceFoundation {
  async savePlan(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ) {
    return this.projectCommand(
      viewer,
      "evaluation.plan.save",
      input,
      command,
      () => this.savePlanD1(viewer, input, command),
    );
  }

  protected async savePlanD1(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const auditActor = evaluationAuditActor(viewer);
    const commandState = await this.prepareApiCommand(
      viewer,
      "evaluation.plan.save",
      command,
      planCommandResultSchema,
    );
    if (commandState.replay) return commandState.replay.planId;
    const commandGuard = this.commandGuard(commandState.prepared);
    const parsed = evaluationPlanSchema.parse(input);
    assertPlanScorecardConsistency(parsed.rounds);
    const blindedReviewing = parsed.rounds.some((round) => round.anonymous)
      ? 1
      : 0;
    const existing = await this.env.DB.prepare(
      `
      SELECT plan.id, plan.revision, plan.decision_role AS decisionRole
        FROM evaluation_plans plan
        JOIN events event
          ON event.id = plan.event_id AND event.organisation_id = ?
       WHERE plan.event_id = ? AND plan.status <> 'archived'
       ORDER BY plan.created_at DESC LIMIT 1
    `,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .first<{
        id: string;
        revision: number;
        decisionRole: "administrator" | "committee_chair";
      }>();
    if (existing && existing.revision !== parsed.revision)
      throw new EvaluationRevisionConflictError(
        "The evaluation plan changed after it was loaded.",
      );
    if (
      !("kind" in viewer) &&
      viewer.role === "committee_chair" &&
      parsed.decisionRole !== (existing?.decisionRole ?? "administrator")
    ) {
      throw new Response(
        "Only an owner or administrator can change final decision authority.",
        { status: 403 },
      );
    }
    const readReplacementBlockingActivity = (planId: string) =>
      this.env.DB.prepare(
        `
        SELECT
          EXISTS (
            SELECT 1
              FROM evaluator_assignments assignment
              JOIN evaluation_rounds assigned_round
                ON assigned_round.id = assignment.round_id
               AND assigned_round.event_id = assignment.event_id
             WHERE assigned_round.plan_id = plan.id
               AND assigned_round.event_id = plan.event_id
          ) AS hasAssignments,
          EXISTS (
            SELECT 1
              FROM ai_review_assessments assessment
              JOIN evaluation_rounds assessed_round
                ON assessed_round.id = assessment.round_id
               AND assessed_round.event_id = assessment.event_id
             WHERE assessed_round.plan_id = plan.id
               AND assessed_round.event_id = plan.event_id
          ) AS hasAiAssessments,
          EXISTS (
            SELECT 1
              FROM operation_jobs operation
              JOIN evaluation_rounds operation_round
                ON operation_round.id = json_extract(
                     operation.payload_json,
                     '$.roundId'
                   )
               AND operation_round.event_id = operation.event_id
             WHERE operation.event_id = plan.event_id
               AND operation.organisation_id = event.organisation_id
               AND operation.type = 'ai.review_assessment.generate'
               AND operation.status = 'running'
               AND json_type(operation.payload_json, '$.roundId') = 'text'
               AND operation_round.plan_id = plan.id
          ) AS hasRunningAiAssessments
          FROM evaluation_plans plan
          JOIN events event
            ON event.id = plan.event_id AND event.organisation_id = ?
         WHERE plan.id = ? AND plan.event_id = ?
      `,
      )
        .bind(viewer.organisationId, planId, viewer.eventId)
        .first<{
          hasAssignments: number;
          hasAiAssessments: number;
          hasRunningAiAssessments: number;
        }>();
    if (existing) {
      const activity = await readReplacementBlockingActivity(existing.id);
      if (activity?.hasAssignments)
        throw new EvaluationStateError(
          "A plan with assignments cannot have its rounds or rubric replaced. Create the next round instead.",
        );
      if (activity?.hasAiAssessments)
        throw new EvaluationStateError(
          "A plan with AI assessments cannot have its rounds or rubric replaced. Create the next round instead.",
        );
      if (activity?.hasRunningAiAssessments)
        throw new EvaluationStateError(
          "Wait for every running AI review assessment in this plan to finish before replacing its rounds or rubric.",
        );
    }
    if (existing) {
      await assertPersistedScorecardConsistency(
        this.env.DB,
        viewer.organisationId,
        viewer.eventId,
        existing.id,
        parsed.rounds,
      );
    }
    const existingReviewerRows = existing
      ? (
          await this.env.DB.prepare(
            `
            SELECT pool.id, pool.round_id AS roundId, pool.person_id AS personId,
                   pool.added_by_person_id AS addedByPersonId,
                   pool.revision, pool.created_at AS createdAt
              FROM evaluation_round_reviewers pool
              JOIN evaluation_rounds round
                ON round.id = pool.round_id AND round.event_id = pool.event_id
              JOIN events event
                ON event.id = pool.event_id AND event.organisation_id = ?
             WHERE pool.event_id = ? AND round.plan_id = ?
          `,
          )
            .bind(viewer.organisationId, viewer.eventId, existing.id)
            .all<{
              id: string;
              roundId: string;
              personId: string;
              addedByPersonId: string | null;
              revision: number;
              createdAt: number;
            }>()
        ).results
      : [];
    const planId = existing?.id ?? crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const planHasNoReplacementBlockingActivity = `
      NOT EXISTS (
        SELECT 1
          FROM evaluator_assignments assignment
          JOIN evaluation_rounds assigned_round
            ON assigned_round.id = assignment.round_id
           AND assigned_round.event_id = assignment.event_id
         WHERE assigned_round.plan_id = ?
           AND assigned_round.event_id = ?
      )
      AND NOT EXISTS (
        SELECT 1
          FROM ai_review_assessments assessment
          JOIN evaluation_rounds assessed_round
            ON assessed_round.id = assessment.round_id
           AND assessed_round.event_id = assessment.event_id
         WHERE assessed_round.plan_id = ?
           AND assessed_round.event_id = ?
      )
      AND NOT EXISTS (
        SELECT 1
          FROM operation_jobs operation
          JOIN evaluation_rounds operation_round
            ON operation_round.id = json_extract(
                 operation.payload_json,
                 '$.roundId'
               )
           AND operation_round.event_id = operation.event_id
         WHERE operation.event_id = ?
           AND operation.organisation_id = ?
           AND operation.type = 'ai.review_assessment.generate'
           AND operation.status = 'running'
           AND json_type(operation.payload_json, '$.roundId') = 'text'
           AND operation_round.plan_id = ?
      )
    `;
    const commandStatements = this.commandClaimStatements(
      commandState.prepared,
    );
    const domainStatementIndex = commandStatements.length;
    const statements: D1PreparedStatement[] = [
      ...commandStatements,
      existing
        ? this.env.DB.prepare(
            `
            UPDATE events
               SET last_operation_id = ?, updated_at = unixepoch()
             WHERE id = ? AND organisation_id = ?
               AND EXISTS (
                 SELECT 1 FROM evaluation_plans plan
                  WHERE plan.id = ? AND plan.event_id = events.id
                    AND plan.revision = ? AND ${planHasNoReplacementBlockingActivity}
               )
               ${commandGuard.sql}
          `,
          ).bind(
            operationId,
            viewer.eventId,
            viewer.organisationId,
            planId,
            parsed.revision,
            planId,
            viewer.eventId,
            planId,
            viewer.eventId,
            viewer.eventId,
            viewer.organisationId,
            planId,
            ...commandGuard.bindings,
          )
        : this.env.DB.prepare(
            `
            UPDATE events
               SET last_operation_id = ?, updated_at = unixepoch()
             WHERE id = ? AND organisation_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM evaluation_plans plan
                  WHERE plan.event_id = events.id AND plan.status <> 'archived'
               )
               ${commandGuard.sql}
          `,
          ).bind(
            operationId,
            viewer.eventId,
            viewer.organisationId,
            ...commandGuard.bindings,
          ),
      ...(existing
        ? [
            this.env.DB.prepare(
              `
        UPDATE evaluation_plans SET name = ?, status = ?, blinded_reviewing = ?, decision_role = ?, revision = revision + 1,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND ${planHasNoReplacementBlockingActivity}
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
            ).bind(
              parsed.name,
              parsed.status,
              blindedReviewing,
              parsed.decisionRole,
              planId,
              viewer.eventId,
              parsed.revision,
              planId,
              viewer.eventId,
              planId,
              viewer.eventId,
              viewer.eventId,
              viewer.organisationId,
              planId,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            ),
            this.env.DB.prepare(
              `
        DELETE FROM evaluation_rounds
         WHERE plan_id = ? AND event_id = ?
           AND ${planHasNoReplacementBlockingActivity}
           AND EXISTS (
             SELECT 1 FROM evaluation_plans
              WHERE id = ? AND event_id = ? AND revision = ? AND name = ? AND status = ?
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
            ).bind(
              // DELETE target.
              planId,
              viewer.eventId,
              // No assignment activity in this plan.
              planId,
              viewer.eventId,
              // No persisted AI assessment activity in this plan.
              planId,
              viewer.eventId,
              // No running AI generation targeting this plan.
              viewer.eventId,
              viewer.organisationId,
              planId,
              // The preceding plan update must still be authoritative.
              planId,
              viewer.eventId,
              parsed.revision + 1,
              parsed.name,
              parsed.status,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            ),
          ]
        : [
            this.env.DB.prepare(
              `
        INSERT INTO evaluation_plans (
          id, event_id, name, status, blinded_reviewing, decision_role, revision,
          created_by_person_id, created_at, updated_at
        ) SELECT ?, e.id, ?, ?, ?, ?, 1, ?, unixepoch(), unixepoch()
          FROM events e
         WHERE e.id = ? AND e.organisation_id = ? AND e.last_operation_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM evaluation_plans current_plan
              WHERE current_plan.event_id = e.id AND current_plan.status <> 'archived'
           )
      `,
            ).bind(
              planId,
              parsed.name,
              parsed.status,
              blindedReviewing,
              parsed.decisionRole,
              auditActor.personId,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            ),
          ]),
    ];
    for (const [roundIndex, round] of parsed.rounds.entries()) {
      const closesAt =
        round.closesAt !== undefined ? round.closesAt : (round.dueAt ?? null);
      statements.push(
        this.env.DB.prepare(
          `
        INSERT INTO evaluation_rounds (
          id, event_id, plan_id, round_number, name, status, opens_at, closes_at,
          blinded_reviewing, scorecard_id, scorecard_version,
          advancement_rule_json, revision, created_at, updated_at
        )
        SELECT ?, p.event_id, p.id, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 1, unixepoch(), unixepoch()
          FROM evaluation_plans p
         WHERE p.id = ? AND p.event_id = ? AND p.revision = ? AND p.name = ? AND p.status = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
        ).bind(
          round.id,
          roundIndex + 1,
          round.name,
          parsed.status === "active" && roundIndex === 0 ? "active" : "draft",
          round.opensAt ? Math.floor(Date.parse(round.opensAt) / 1_000) : null,
          closesAt ? Math.floor(Date.parse(closesAt) / 1_000) : null,
          round.anonymous ? 1 : 0,
          round.scorecardId ?? round.id,
          round.scorecardVersion,
          planId,
          viewer.eventId,
          parsed.revision + 1,
          parsed.name,
          parsed.status,
          viewer.eventId,
          viewer.organisationId,
          operationId,
        ),
      );
      for (const criterion of round.criteria) {
        statements.push(
          this.env.DB.prepare(
            `
          INSERT INTO evaluation_criteria (
            id, event_id, round_id, name, description, input_type, options_json,
            weight_percent, required, position
          )
          SELECT ?, r.event_id, r.id, ?, ?, ?, ?, ?, ?, ?
            FROM evaluation_rounds r
            JOIN evaluation_plans p ON p.id = r.plan_id AND p.event_id = r.event_id
           WHERE r.id = ? AND r.event_id = ? AND p.id = ? AND p.revision = ? AND p.name = ? AND p.status = ?
             AND EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
             )
        `,
          ).bind(
            criterion.id,
            criterion.name,
            criterion.description || null,
            criterion.inputType,
            JSON.stringify(criterion.options),
            criterion.weightPercent,
            criterion.required ? 1 : 0,
            criterion.position,
            round.id,
            viewer.eventId,
            planId,
            parsed.revision + 1,
            parsed.name,
            parsed.status,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          ),
        );
      }
      for (const reviewer of existingReviewerRows.filter(
        (candidate) => candidate.roundId === round.id,
      )) {
        statements.push(
          this.env.DB.prepare(
            `
            INSERT INTO evaluation_round_reviewers (
              id, event_id, round_id, person_id, added_by_person_id,
              revision, created_at, updated_at
            )
            SELECT ?, r.event_id, r.id, ?, ?, ?, ?, unixepoch()
              FROM evaluation_rounds r
              JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
             WHERE r.id = ? AND r.event_id = ? AND r.plan_id = ?
          `,
          ).bind(
            reviewer.id,
            reviewer.personId,
            reviewer.addedByPersonId,
            reviewer.revision,
            reviewer.createdAt,
            viewer.organisationId,
            round.id,
            viewer.eventId,
            planId,
          ),
        );
      }
    }
    statements.push(
      this.env.DB.prepare(
        `
      INSERT INTO audit_events (
        id, organisation_id, event_id, actor_person_id, actor_id, action, entity_type, entity_id, metadata_json, created_at
      )
      SELECT ?, ?, ?, ?, ?, 'evaluation.plan.saved', 'evaluation_plan', ?, ?, unixepoch()
       WHERE EXISTS (
         SELECT 1 FROM evaluation_plans
          WHERE id = ? AND event_id = ? AND revision = ? AND name = ? AND status = ?
       )
       AND EXISTS (
         SELECT 1 FROM events
          WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
       )
    `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        auditActor.actorId,
        planId,
        JSON.stringify({
          rounds: parsed.rounds.length,
          blindedReviewing: Boolean(blindedReviewing),
        }),
        planId,
        viewer.eventId,
        parsed.revision + 1,
        parsed.name,
        parsed.status,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    );
    if (commandState.prepared) {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE idempotency_records
             SET status = 'completed', response_status = 200,
                 response_json = json_object('planId', ?),
                 entity_type = 'evaluation_plan', entity_id = ?,
                 completed_at = unixepoch()
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'evaluation.plan.save'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND EXISTS (
               SELECT 1 FROM evaluation_plans committed_plan
                WHERE committed_plan.id = ?
                  AND committed_plan.event_id = idempotency_records.event_id
                  AND committed_plan.revision = ?
             )
             AND EXISTS (
               SELECT 1 FROM events committed_event
                WHERE committed_event.id = idempotency_records.event_id
                  AND committed_event.organisation_id = idempotency_records.organisation_id
                  AND committed_event.last_operation_id = ?
             )
        `,
        ).bind(
          planId,
          planId,
          commandState.prepared.recordId,
          viewer.organisationId,
          viewer.eventId,
          commandState.prepared.actor.actorId,
          commandState.prepared.input.idempotencyKey,
          commandState.prepared.input.requestHash,
          planId,
          parsed.revision + 1,
          operationId,
        ),
      );
    }
    const results = await this.env.DB.batch(statements);
    const claimed = results[domainStatementIndex]!;
    if ((claimed.meta.changes ?? 0) !== 1) {
      const replay = await this.recoverApiCommand(commandState.prepared);
      if (replay) return replay.planId;
      if (existing) {
        const activity = await readReplacementBlockingActivity(existing.id);
        if (activity?.hasAssignments) {
          throw new EvaluationStateError(
            "A plan with assignments cannot have its rounds or rubric replaced. Create the next round instead.",
          );
        }
        if (activity?.hasAiAssessments) {
          throw new EvaluationStateError(
            "A plan with AI assessments cannot have its rounds or rubric replaced. Create the next round instead.",
          );
        }
        if (activity?.hasRunningAiAssessments) {
          throw new EvaluationStateError(
            "A running AI review assessment appeared before the plan could be replaced. Wait for it to finish and try again.",
          );
        }
      }
      throw new EvaluationRevisionConflictError(
        "The evaluation plan changed after it was loaded.",
      );
    }
    if (commandState.prepared) {
      const replay = await this.readApiCommand(commandState.prepared);
      if (!replay) {
        throw new Error(
          "The evaluation plan command did not commit an idempotency result.",
        );
      }
      return replay.planId;
    }
    return planId;
  }
}
