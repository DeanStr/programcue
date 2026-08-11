import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { EvaluationConfigurationWorkflows } from "./evaluation-configuration-workflows.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
} from "./evaluation-errors";
import {
  draftRoundUpdateSchema,
  nextRoundSchema,
  roundAdvancementSchema,
} from "./evaluation-schema";
import {
  advancementCommandResultSchema,
  evaluationAuditActor,
  roundCommandResultSchema,
  type Criterion,
  type EvaluationAdminActor,
  type EvaluationAdvancementExecutionResult,
  type EvaluationAdvancementResult,
  type EvaluationApiCommand,
} from "./evaluation-service-foundation.server";

export abstract class EvaluationRoundWorkflows extends EvaluationConfigurationWorkflows {
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
    const [plan, clone, criteria] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT id, revision FROM evaluation_plans
         WHERE id = ? AND event_id = ? AND status IN ('draft','active')
      `,
      )
        .bind(parsed.planId, viewer.eventId)
        .first<{ id: string; revision: number }>(),
      this.env.DB.prepare(
        `
        SELECT id FROM evaluation_rounds
         WHERE id = ? AND event_id = ? AND plan_id = ?
      `,
      )
        .bind(parsed.cloneRoundId, viewer.eventId, parsed.planId)
        .first<{ id: string }>(),
      this.env.DB.prepare(
        `
        SELECT name, description, input_type AS inputType,
               weight_percent AS weightPercent, required, position
          FROM evaluation_criteria
         WHERE event_id = ? AND round_id = ? ORDER BY position
      `,
      )
        .bind(viewer.eventId, parsed.cloneRoundId)
        .all<Omit<Criterion, "id">>(),
    ]);
    if (!plan || !clone || criteria.results.length === 0) {
      throw new EvaluationStateError(
        "The plan or source rubric is no longer available.",
      );
    }
    if (plan.revision !== parsed.planRevision) {
      throw new EvaluationRevisionConflictError(
        "The evaluation plan changed before the round could be added.",
      );
    }
    const roundId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const dueAt = parsed.dueAt
      ? Math.floor(Date.parse(parsed.dueAt) / 1_000)
      : null;
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
        parsed.cloneRoundId,
        parsed.planId,
        ...commandGuard.bindings,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_plans
           SET revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
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
          id, event_id, plan_id, round_number, name, status, closes_at,
          advancement_rule_json, revision, created_at, updated_at
        )
        SELECT ?, p.event_id, p.id,
               COALESCE((SELECT MAX(round_number) FROM evaluation_rounds
                          WHERE event_id = p.event_id AND plan_id = p.id), 0) + 1,
               ?, 'draft', ?,
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
        dueAt,
        parsed.planId,
        viewer.eventId,
        parsed.planRevision + 1,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    ];
    for (const criterion of criteria.results) {
      statements.push(
        this.env.DB.prepare(
          `
          INSERT INTO evaluation_criteria (
            id, event_id, round_id, name, description, input_type,
            weight_percent, required, position
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM evaluation_rounds
              WHERE id = ? AND event_id = ? AND plan_id = ?
           )
        `,
        ).bind(
          crypto.randomUUID(),
          viewer.eventId,
          roundId,
          criterion.name,
          criterion.description,
          criterion.inputType,
          criterion.weightPercent,
          criterion.required ? 1 : 0,
          criterion.position,
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
           SELECT 1 FROM evaluation_rounds WHERE id = ? AND event_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        auditActor.actorId,
        roundId,
        JSON.stringify({ clonedFromRoundId: parsed.cloneRoundId }),
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
    const dueAt = parsed.dueAt
      ? Math.floor(Date.parse(parsed.dueAt) / 1_000)
      : null;
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ?
           AND EXISTS (
             SELECT 1 FROM evaluation_rounds draft_round
              WHERE draft_round.id = ? AND draft_round.event_id = events.id
                AND draft_round.status = 'draft'
                AND draft_round.revision = ?
                AND NOT EXISTS (
                  SELECT 1 FROM evaluator_assignments assignment
                   WHERE assignment.event_id = draft_round.event_id
                     AND assignment.round_id = draft_round.id
                )
           )
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.roundId,
        parsed.revision,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_rounds SET name = ?, closes_at = ?,
               revision = revision + 1, last_operation_id = ?,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ? AND status = 'draft'
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
        dueAt,
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
                AND name = ? AND status = 'draft'
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
            weight_percent, required, position
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM evaluation_rounds
              WHERE id = ? AND event_id = ? AND revision = ?
                AND name = ? AND status = 'draft'
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
              AND name = ? AND status = 'draft'
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
      throw new EvaluationRevisionConflictError(
        "The draft round changed or received assignments before it could be updated.",
      );
    }
  }

  async advanceRound(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ): Promise<EvaluationAdvancementExecutionResult> {
    return this.projectCommand(
      viewer,
      "evaluation.advance",
      input,
      command,
      () => this.advanceRoundD1(viewer, input, command),
    );
  }

  protected async advanceRoundD1(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ): Promise<EvaluationAdvancementExecutionResult> {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const auditActor = evaluationAuditActor(viewer);
    const commandState = await this.prepareApiCommand(
      viewer,
      "evaluation.advance",
      command,
      advancementCommandResultSchema,
    );
    if (commandState.replay) return commandState.replay;
    const commandGuard = this.commandGuard(commandState.prepared);
    const parsed = roundAdvancementSchema.parse(input);
    const evaluatorPersonIds = await this.resolveEvaluatorTarget(
      viewer,
      parsed.teamId,
      parsed.evaluatorPersonIds,
    );
    const submissionPlaceholders = parsed.submissionIds
      .map(() => "?")
      .join(",");
    const evaluatorPlaceholders = evaluatorPersonIds.map(() => "?").join(",");
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const result: EvaluationAdvancementResult = {
      advancedSubmissionCount: parsed.submissionIds.length,
      assignmentCount: parsed.submissionIds.length * evaluatorPersonIds.length,
    };
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "round.advanced",
        entityType: "evaluation_round",
        entityId: parsed.toRoundId,
        idempotencyKey: `round.advanced:${parsed.toRoundId}:${parsed.toRoundRevision + 1}`,
        correlationId: operationId,
        data: {
          fromRoundId: parsed.fromRoundId,
          toRoundId: parsed.toRoundId,
          advancedSubmissionCount: result.advancedSubmissionCount,
          assignmentCount: result.assignmentCount,
        },
      },
      auditEventId,
    );
    const eligibilitySql = `
      EXISTS (
        SELECT 1
          FROM evaluation_rounds source_round
          JOIN evaluation_rounds target_round
            ON target_round.plan_id = source_round.plan_id
           AND target_round.event_id = source_round.event_id
           AND target_round.round_number = source_round.round_number + 1
         WHERE source_round.id = ? AND source_round.event_id = ?
           AND source_round.status = 'active' AND source_round.revision = ?
           AND target_round.id = ? AND target_round.status = 'draft'
           AND target_round.revision = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM evaluator_assignments unfinished
         WHERE unfinished.event_id = ? AND unfinished.round_id = ?
           AND unfinished.status IN ('assigned','in_progress','reopened')
      )
      AND NOT EXISTS (
        SELECT 1 FROM evaluator_assignments existing_target_assignment
         WHERE existing_target_assignment.event_id = ?
           AND existing_target_assignment.round_id = ?
      )
      AND (
        SELECT COUNT(DISTINCT eligible.submission_id)
          FROM evaluator_assignments eligible
          JOIN reviews completed_review
            ON completed_review.assignment_id = eligible.id
           AND completed_review.event_id = eligible.event_id
           AND completed_review.status IN ('submitted','locked')
          JOIN submissions candidate
            ON candidate.id = eligible.submission_id
           AND candidate.event_id = eligible.event_id
         WHERE eligible.event_id = ? AND eligible.round_id = ?
           AND eligible.submission_id IN (${submissionPlaceholders})
           AND candidate.status IN ('assigned','in_review','decision_ready')
           AND NOT EXISTS (
             SELECT 1 FROM submission_decisions final_decision
              WHERE final_decision.event_id = candidate.event_id
                AND final_decision.submission_id = candidate.id
                AND final_decision.status = 'published'
           )
      ) = ?
      AND (
        SELECT COUNT(DISTINCT m.person_id) FROM memberships m
         WHERE m.event_id = ? AND m.accepted_at IS NOT NULL
           AND m.revoked_at IS NULL
           AND m.role IN ('evaluator','committee_chair')
           AND m.person_id IN (${evaluatorPlaceholders})
      ) = ?
      ${
        parsed.teamId
          ? `AND (
        SELECT COUNT(DISTINCT tm.person_id)
          FROM evaluation_team_members tm
          JOIN evaluation_teams t
            ON t.id = tm.team_id AND t.event_id = tm.event_id
          JOIN memberships team_membership
            ON team_membership.event_id = tm.event_id
           AND team_membership.person_id = tm.person_id
           AND team_membership.accepted_at IS NOT NULL
           AND team_membership.revoked_at IS NULL
           AND team_membership.role IN ('evaluator','committee_chair')
         WHERE tm.event_id = ? AND tm.team_id = ? AND tm.removed_at IS NULL
           AND t.status = 'active'
           AND tm.person_id IN (${evaluatorPlaceholders})
      ) = ?
      AND (
        SELECT COUNT(DISTINCT tm.person_id)
          FROM evaluation_team_members tm
          JOIN evaluation_teams t
            ON t.id = tm.team_id AND t.event_id = tm.event_id
          JOIN memberships team_membership
            ON team_membership.event_id = tm.event_id
           AND team_membership.person_id = tm.person_id
           AND team_membership.accepted_at IS NOT NULL
           AND team_membership.revoked_at IS NULL
           AND team_membership.role IN ('evaluator','committee_chair')
         WHERE tm.event_id = ? AND tm.team_id = ? AND tm.removed_at IS NULL
           AND t.status = 'active'
      ) = ?`
          : ""
      }
    `;
    const eligibilityBindings: unknown[] = [
      parsed.fromRoundId,
      viewer.eventId,
      parsed.fromRoundRevision,
      parsed.toRoundId,
      parsed.toRoundRevision,
      viewer.eventId,
      parsed.fromRoundId,
      viewer.eventId,
      parsed.toRoundId,
      viewer.eventId,
      parsed.fromRoundId,
      ...parsed.submissionIds,
      parsed.submissionIds.length,
      viewer.eventId,
      ...evaluatorPersonIds,
      evaluatorPersonIds.length,
      ...(parsed.teamId
        ? [
            viewer.eventId,
            parsed.teamId,
            ...evaluatorPersonIds,
            evaluatorPersonIds.length,
            viewer.eventId,
            parsed.teamId,
            evaluatorPersonIds.length,
          ]
        : []),
    ];
    const commandStatements = this.commandClaimStatements(
      commandState.prepared,
    );
    const domainStatementIndex = commandStatements.length;
    const statements: D1PreparedStatement[] = [
      ...commandStatements,
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ? AND ${eligibilitySql}
           ${commandGuard.sql}
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        ...eligibilityBindings,
        ...commandGuard.bindings,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_rounds SET status = 'closed',
               revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ? AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        parsed.fromRoundId,
        viewer.eventId,
        parsed.fromRoundRevision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_rounds SET status = 'active', opens_at = unixepoch(),
               revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ? AND status = 'draft'
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        parsed.toRoundId,
        viewer.eventId,
        parsed.toRoundRevision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE reviews SET status = 'locked', locked_at = unixepoch(),
               updated_at = unixepoch()
         WHERE event_id = ? AND status = 'submitted'
           AND assignment_id IN (
             SELECT id FROM evaluator_assignments
              WHERE event_id = ? AND round_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        viewer.eventId,
        parsed.fromRoundId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE submissions SET status = 'decision_ready',
               revision = revision + 1, updated_at = unixepoch()
         WHERE event_id = ? AND status IN ('assigned','in_review')
           AND id IN (
             SELECT submission_id FROM evaluator_assignments
              WHERE event_id = ? AND round_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        viewer.eventId,
        parsed.fromRoundId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    ];
    for (const submissionId of parsed.submissionIds) {
      for (const evaluatorPersonId of evaluatorPersonIds) {
        statements.push(
          this.env.DB.prepare(
            `
            INSERT INTO evaluator_assignments (
              id, event_id, round_id, submission_id, evaluator_person_id,
              team_id, status, revision, last_operation_id, assigned_at
            )
            SELECT ?, ?, ?, ?, ?, ?, 'assigned', 1, ?, unixepoch()
             WHERE EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
             )
          `,
          ).bind(
            crypto.randomUUID(),
            viewer.eventId,
            parsed.toRoundId,
            submissionId,
            evaluatorPersonId,
            parsed.teamId,
            operationId,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          ),
        );
      }
    }
    statements.push(
      this.env.DB.prepare(
        `
        UPDATE submissions SET status = 'assigned',
               revision = revision + 1, updated_at = unixepoch()
         WHERE event_id = ? AND id IN (${submissionPlaceholders})
           AND status = 'decision_ready'
           AND (
             SELECT COUNT(*) FROM evaluator_assignments next_assignment
              WHERE next_assignment.event_id = submissions.event_id
                AND next_assignment.round_id = ?
                AND next_assignment.submission_id = submissions.id
                AND next_assignment.last_operation_id = ?
           ) = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        ...parsed.submissionIds,
        parsed.toRoundId,
        operationId,
        evaluatorPersonIds.length,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, actor_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'evaluation.round.advanced',
               'evaluation_round', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluation_rounds
            WHERE id = ? AND event_id = ? AND status = 'active'
         )
           AND (
             SELECT COUNT(*) FROM submissions
              WHERE event_id = ? AND id IN (${submissionPlaceholders})
                AND status = 'assigned'
           ) = ?
      `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        auditActor.actorId,
        parsed.toRoundId,
        JSON.stringify({
          fromRoundId: parsed.fromRoundId,
          submissionIds: parsed.submissionIds,
          evaluatorPersonIds,
          teamId: parsed.teamId,
        }),
        parsed.toRoundId,
        viewer.eventId,
        viewer.eventId,
        ...parsed.submissionIds,
        parsed.submissionIds.length,
      ),
    );
    if (commandState.prepared) {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE idempotency_records
             SET status = 'completed', response_status = 200,
                 response_json = json_object(
                   'advancedSubmissionCount', ?,
                   'assignmentCount', ?
                 ),
                 entity_type = 'evaluation_round', entity_id = ?,
                 completed_at = unixepoch()
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'evaluation.advance'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND EXISTS (
               SELECT 1 FROM evaluation_rounds committed_round
                WHERE committed_round.id = ?
                  AND committed_round.event_id = idempotency_records.event_id
                  AND committed_round.status = 'active'
             )
             AND (
               SELECT COUNT(*) FROM evaluator_assignments committed_assignment
                WHERE committed_assignment.event_id = idempotency_records.event_id
                  AND committed_assignment.round_id = ?
                  AND committed_assignment.last_operation_id = ?
             ) = ?
        `,
        ).bind(
          result.advancedSubmissionCount,
          result.assignmentCount,
          parsed.toRoundId,
          commandState.prepared.recordId,
          viewer.organisationId,
          viewer.eventId,
          commandState.prepared.actor.actorId,
          commandState.prepared.input.idempotencyKey,
          commandState.prepared.input.requestHash,
          parsed.toRoundId,
          parsed.toRoundId,
          operationId,
          result.assignmentCount,
        ),
      );
    }
    statements.push(...preparedWebhook.statements);
    const results = await this.env.DB.batch(statements);
    const claimed = results[domainStatementIndex]!;
    if ((claimed.meta.changes ?? 0) !== 1) {
      const replay = await this.recoverApiCommand(commandState.prepared);
      if (replay) return replay;
      throw new EvaluationRevisionConflictError(
        "Round advancement could not be committed. Complete all current assignments and refresh the plan before trying again.",
      );
    }
    const webhookDeliveries =
      await webhookService.dispatchPreparedEvent(preparedWebhook);
    if (commandState.prepared) {
      const replay = await this.readApiCommand(commandState.prepared);
      if (!replay) {
        throw new Error(
          "The evaluation advancement command did not commit an idempotency result.",
        );
      }
      return replay;
    }
    return { ...result, webhookDeliveries };
  }
}
