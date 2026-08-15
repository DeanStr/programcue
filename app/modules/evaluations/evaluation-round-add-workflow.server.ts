import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
} from "./evaluation-errors";
import { nextRoundSchema } from "./evaluation-schema";
import {
  EvaluationServiceFoundation,
  evaluationAuditActor,
  persistedRubricSignature,
  roundCommandResultSchema,
  type Criterion,
  type EvaluationAdminActor,
  type EvaluationApiCommand,
} from "./evaluation-service-foundation.server";

import {
  assertEffectiveRoundDateRange,
  requireScorecardSourceRoundId,
} from "./evaluation-round-workflow-support.server";

export class EvaluationRoundAddWorkflow extends EvaluationServiceFoundation {
  async addNextRound(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ) {
    return this.projectCommand(
      viewer,
      "evaluation.round.add",
      input,
      command,
      () => this.addNextRoundD1(viewer, input, command),
    );
  }

  protected async addNextRoundD1(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const auditActor = evaluationAuditActor(viewer);
    const commandState = await this.prepareApiCommand(
      viewer,
      "evaluation.round.add",
      command,
      roundCommandResultSchema,
    );
    if (commandState.replay) return commandState.replay.roundId;
    const commandGuard = this.commandGuard(commandState.prepared);
    const parsed = nextRoundSchema.parse(input);
    const [plan, clone, cloneCriteria] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT p.id, p.revision FROM evaluation_plans p
        JOIN events e ON e.id = p.event_id AND e.organisation_id = ?
         WHERE p.id = ? AND p.event_id = ? AND p.status IN ('draft','active')
      `,
      )
        .bind(viewer.organisationId, parsed.planId, viewer.eventId)
        .first<{ id: string; revision: number }>(),
      this.env.DB.prepare(
        `
        SELECT r.id, blinded_reviewing AS anonymous,
               opens_at AS opensAt, closes_at AS closesAt,
               scorecard_id AS scorecardId,
               scorecard_version AS scorecardVersion
          FROM evaluation_rounds r
          JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
         WHERE r.id = ? AND r.event_id = ? AND r.plan_id = ?
      `,
      )
        .bind(
          viewer.organisationId,
          parsed.cloneRoundId,
          viewer.eventId,
          parsed.planId,
        )
        .first<{
          id: string;
          anonymous: number | boolean;
          opensAt: number | null;
          closesAt: number | null;
          scorecardId: string;
          scorecardVersion: number;
        }>(),
      this.env.DB.prepare(
        `
        SELECT c.name, c.description, c.input_type AS inputType,
               c.options_json AS optionsJson, c.weight_percent AS weightPercent,
               c.required, c.position
          FROM evaluation_criteria c
          JOIN events e ON e.id = c.event_id AND e.organisation_id = ?
         WHERE c.event_id = ? AND c.round_id = ? ORDER BY position
      `,
      )
        .bind(viewer.organisationId, viewer.eventId, parsed.cloneRoundId)
        .all<Omit<Criterion, "id" | "options"> & { optionsJson: string }>(),
    ]);
    if (!plan || !clone || cloneCriteria.results.length === 0) {
      throw new EvaluationStateError(
        "The plan or source rubric is no longer available.",
      );
    }
    if (plan.revision !== parsed.planRevision) {
      throw new EvaluationRevisionConflictError(
        "The evaluation plan changed before the round could be added.",
      );
    }
    const duplicateRound = await this.env.DB.prepare(
      `
      SELECT r.id
        FROM evaluation_rounds r
        JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
       WHERE r.event_id = ? AND r.plan_id = ?
         AND trim(r.name) = trim(?) COLLATE NOCASE
       LIMIT 1
    `,
    )
      .bind(viewer.organisationId, viewer.eventId, parsed.planId, parsed.name)
      .first();
    if (duplicateRound) {
      throw new EvaluationStateError(
        "An evaluation round with that name already exists in this plan.",
      );
    }
    let criteriaToClone = cloneCriteria.results;
    let selectedScorecardSourceRoundId: string | null = null;
    if (parsed.scorecardId) {
      const sourceRoundId = await requireScorecardSourceRoundId(
        this.env.DB,
        viewer.organisationId,
        viewer.eventId,
        parsed.planId,
        parsed.scorecardId,
        parsed.scorecardVersion ?? 1,
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
          parsed.planId,
        )
        .all<Omit<Criterion, "id" | "options"> & { optionsJson: string }>();
      if (selectedCriteria.results.length === 0) {
        throw new EvaluationStateError(
          "The selected scorecard has no persisted rubric.",
        );
      }
      persistedRubricSignature(selectedCriteria.results);
      criteriaToClone = selectedCriteria.results;
      selectedScorecardSourceRoundId = sourceRoundId;
    }
    const roundId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const opensAt = parsed.opensAt !== undefined ? parsed.opensAt : null;
    const closesAtValue =
      parsed.closesAt !== undefined ? parsed.closesAt : (parsed.dueAt ?? null);
    assertEffectiveRoundDateRange(opensAt, closesAtValue);
    const anonymous = parsed.anonymous ?? Boolean(clone.anonymous);
    const scorecardId = parsed.scorecardId ?? roundId;
    const scorecardVersion = parsed.scorecardVersion ?? 1;
    const commandStatements = this.commandClaimStatements(
      commandState.prepared,
    );
    const domainStatementIndex = commandStatements.length;
    const statements: D1PreparedStatement[] = [
      ...commandStatements,
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ?
           AND EXISTS (
             SELECT 1 FROM evaluation_plans p
              WHERE p.id = ? AND p.event_id = events.id
                AND p.revision = ? AND p.status IN ('draft','active')
                AND (SELECT COUNT(*) FROM evaluation_rounds r
                      WHERE r.plan_id = p.id AND r.event_id = p.event_id) < 10
                AND NOT EXISTS (
                  SELECT 1 FROM evaluation_rounds named_round
                   WHERE named_round.plan_id = p.id
                     AND named_round.event_id = p.event_id
                     AND trim(named_round.name) = trim(?) COLLATE NOCASE
                )
           )
           AND EXISTS (
             SELECT 1 FROM evaluation_rounds source_round
              WHERE source_round.id = ? AND source_round.event_id = events.id
                AND source_round.plan_id = ?
           )
           ${commandGuard.sql}
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.planId,
        parsed.planRevision,
        parsed.name,
        parsed.cloneRoundId,
        parsed.planId,
        ...commandGuard.bindings,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_plans
           SET revision = revision + 1,
               blinded_reviewing = CASE WHEN ? = 1 OR EXISTS (
                 SELECT 1 FROM evaluation_rounds plan_round
                  WHERE plan_round.plan_id = evaluation_plans.id
                    AND plan_round.event_id = evaluation_plans.event_id
                    AND plan_round.blinded_reviewing = 1
               ) THEN 1 ELSE 0 END,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        anonymous ? 1 : 0,
        parsed.planId,
        viewer.eventId,
        parsed.planRevision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO evaluation_rounds (
          id, event_id, plan_id, round_number, name, status, opens_at, closes_at,
          blinded_reviewing, scorecard_id, scorecard_version,
          advancement_rule_json, revision, created_at, updated_at
        )
        SELECT ?, p.event_id, p.id,
               COALESCE((SELECT MAX(round_number) FROM evaluation_rounds
                          WHERE event_id = p.event_id AND plan_id = p.id), 0) + 1,
               ?, 'draft', ?, ?, ?, ?, ?,
               '{}', 1, unixepoch(), unixepoch()
          FROM evaluation_plans p
         WHERE p.id = ? AND p.event_id = ? AND p.revision = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        roundId,
        parsed.name,
        opensAt ? Math.floor(Date.parse(opensAt) / 1_000) : null,
        closesAtValue ? Math.floor(Date.parse(closesAtValue) / 1_000) : null,
        anonymous ? 1 : 0,
        scorecardId,
        scorecardVersion,
        parsed.planId,
        viewer.eventId,
        parsed.planRevision + 1,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    ];
    for (const criterion of criteriaToClone) {
      statements.push(
        this.env.DB.prepare(
          `
          INSERT INTO evaluation_criteria (
            id, event_id, round_id, name, description, input_type,
            options_json, weight_percent, required, position
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM evaluation_rounds source_round
              JOIN events source_event
                ON source_event.id = source_round.event_id
               AND source_event.organisation_id = ?
              WHERE source_round.id = ? AND source_round.event_id = ?
                AND source_round.plan_id = ?
           )
        `,
        ).bind(
          crypto.randomUUID(),
          viewer.eventId,
          roundId,
          criterion.name,
          criterion.description,
          criterion.inputType,
          criterion.optionsJson,
          criterion.weightPercent,
          criterion.required ? 1 : 0,
          criterion.position,
          viewer.organisationId,
          roundId,
          viewer.eventId,
          parsed.planId,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, actor_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'evaluation.round.created',
               'evaluation_round', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluation_rounds round
           JOIN events event
             ON event.id = round.event_id AND event.organisation_id = ?
            WHERE round.id = ? AND round.event_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        auditActor.actorId,
        roundId,
        JSON.stringify({
          clonedFromRoundId: parsed.cloneRoundId,
          scorecardId,
          scorecardVersion,
          scorecardSourceRoundId: selectedScorecardSourceRoundId,
        }),
        viewer.organisationId,
        roundId,
        viewer.eventId,
      ),
    );
    if (commandState.prepared) {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE idempotency_records
             SET status = 'completed', response_status = 201,
                 response_json = json_object('roundId', ?),
                 entity_type = 'evaluation_round', entity_id = ?,
                 completed_at = unixepoch()
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'evaluation.round.add'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND EXISTS (
               SELECT 1 FROM evaluation_rounds committed_round
                WHERE committed_round.id = ?
                  AND committed_round.event_id = idempotency_records.event_id
                  AND committed_round.plan_id = ?
             )
             AND EXISTS (
               SELECT 1 FROM events committed_event
                WHERE committed_event.id = idempotency_records.event_id
                  AND committed_event.organisation_id = idempotency_records.organisation_id
                  AND committed_event.last_operation_id = ?
             )
        `,
        ).bind(
          roundId,
          roundId,
          commandState.prepared.recordId,
          viewer.organisationId,
          viewer.eventId,
          commandState.prepared.actor.actorId,
          commandState.prepared.input.idempotencyKey,
          commandState.prepared.input.requestHash,
          roundId,
          parsed.planId,
          operationId,
        ),
      );
    }
    const results = await this.env.DB.batch(statements);
    const claimed = results[domainStatementIndex]!;
    if ((claimed.meta.changes ?? 0) !== 1) {
      const replay = await this.recoverApiCommand(commandState.prepared);
      if (replay) return replay.roundId;
      throw new EvaluationRevisionConflictError(
        "The evaluation plan changed before the round could be added.",
      );
    }
    if (commandState.prepared) {
      const replay = await this.readApiCommand(commandState.prepared);
      if (!replay) {
        throw new Error(
          "The evaluation round command did not commit an idempotency result.",
        );
      }
      return replay.roundId;
    }
    return roundId;
  }
}
