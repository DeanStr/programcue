import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
} from "./evaluation-errors";
import {
  draftRoundUpdateSchema,
  evaluationRoundDeleteSchema,
  nextRoundSchema,
  roundAdvancementSchema,
} from "./evaluation-schema";
import {
  advancementCommandResultSchema,
  EvaluationServiceFoundation,
  evaluationAuditActor,
  persistedRubricSignature,
  roundCommandResultSchema,
  rubricSignature,
  type Criterion,
  type EvaluationAdminActor,
  type EvaluationAdvancementExecutionResult,
  type EvaluationAdvancementResult,
  type EvaluationApiCommand,
  type PersistedRubricShape,
} from "./evaluation-service-foundation.server";
import { reviewableSubmissionSql } from "./evaluation-submission-review-eligibility.server";

function assertEffectiveRoundDateRange(
  opensAt: string | null,
  closesAt: string | null,
) {
  if (opensAt && closesAt && Date.parse(closesAt) <= Date.parse(opensAt)) {
    throw new EvaluationStateError(
      "The round close date must be after its open date.",
    );
  }
}

async function hasRunningAiAssessmentForRound(
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

async function requireScorecardSourceRoundId(
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

export class EvaluationRoundWorkflows extends EvaluationServiceFoundation {
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

  async deleteDraftRound(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.round.delete",
      input,
      undefined,
      () => this.deleteDraftRoundD1(viewer, input),
    );
  }

  protected async deleteDraftRoundD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = evaluationRoundDeleteSchema.parse(input);
    const round = await this.env.DB.prepare(
      `
      SELECT r.plan_id AS planId, r.name, r.status, r.revision,
             r.round_number AS roundNumber, p.revision AS planRevision,
             CASE WHEN r.round_number = (
               SELECT MAX(plan_round.round_number)
                 FROM evaluation_rounds plan_round
                WHERE plan_round.event_id = r.event_id
                  AND plan_round.plan_id = r.plan_id
             ) THEN 1 ELSE 0 END AS lastRound,
             (SELECT COUNT(*) FROM evaluation_rounds plan_round
               WHERE plan_round.event_id = r.event_id
                 AND plan_round.plan_id = r.plan_id) AS roundCount,
             EXISTS (
               SELECT 1 FROM evaluator_assignments assignment
                WHERE assignment.event_id = r.event_id
                  AND assignment.round_id = r.id
               UNION ALL
               SELECT 1 FROM evaluator_conflicts conflict
                WHERE conflict.event_id = r.event_id
                  AND conflict.round_id = r.id
               UNION ALL
               SELECT 1 FROM review_moderations moderation
                WHERE moderation.event_id = r.event_id
                  AND moderation.round_id = r.id
               UNION ALL
               SELECT 1 FROM submission_decisions decision
                WHERE decision.event_id = r.event_id
                  AND decision.round_id = r.id
               UNION ALL
               SELECT 1 FROM ai_review_assessments assessment
                WHERE assessment.event_id = r.event_id
                  AND assessment.round_id = r.id
             ) AS hasActivity,
             EXISTS (
               SELECT 1 FROM operation_jobs operation
                WHERE operation.event_id = r.event_id
                  AND operation.organisation_id = e.organisation_id
                  AND operation.type = 'ai.review_assessment.generate'
                  AND operation.status = 'running'
                  AND json_type(operation.payload_json, '$.roundId') = 'text'
                  AND json_extract(operation.payload_json, '$.roundId') = r.id
             ) AS hasRunningAiAssessment
        FROM evaluation_rounds r
        JOIN evaluation_plans p
          ON p.id = r.plan_id AND p.event_id = r.event_id
         AND p.status IN ('draft','active')
        JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
       WHERE r.id = ? AND r.event_id = ?
    `,
    )
      .bind(viewer.organisationId, parsed.roundId, viewer.eventId)
      .first<{
        planId: string;
        name: string;
        status: string;
        revision: number;
        roundNumber: number;
        planRevision: number;
        roundCount: number;
        lastRound: number | boolean;
        hasActivity: number | boolean;
        hasRunningAiAssessment: number | boolean;
      }>();
    if (!round) {
      throw new EvaluationStateError(
        "The evaluation round is not available in this event.",
      );
    }
    const reviewerRows = await this.env.DB.prepare(
      `SELECT pool.person_id AS personId
         FROM evaluation_round_reviewers pool
         JOIN events event
           ON event.id = pool.event_id AND event.organisation_id = ?
        WHERE pool.event_id = ? AND pool.round_id = ?
        ORDER BY pool.person_id`,
    )
      .bind(viewer.organisationId, viewer.eventId, parsed.roundId)
      .all<{ personId: string }>();
    const expectedReviewerPersonIds = [
      ...parsed.expectedReviewerPersonIds,
    ].sort();
    const currentReviewerPersonIds = reviewerRows.results.map(
      (reviewer) => reviewer.personId,
    );
    if (
      currentReviewerPersonIds.length !== expectedReviewerPersonIds.length ||
      currentReviewerPersonIds.some(
        (personId, index) => personId !== expectedReviewerPersonIds[index],
      )
    ) {
      throw new EvaluationRevisionConflictError(
        "The round reviewer pool changed after the deletion was confirmed. Refresh and review the affected reviewers before trying again.",
      );
    }
    if (
      round.revision !== parsed.roundRevision ||
      round.planRevision !== parsed.planRevision
    ) {
      throw new EvaluationRevisionConflictError(
        "The evaluation plan or round changed before it could be deleted.",
      );
    }
    if (round.status !== "draft") {
      throw new EvaluationStateError(
        "Only a draft evaluation round can be deleted.",
      );
    }
    if (round.roundCount <= 1) {
      throw new EvaluationStateError(
        "An evaluation plan must keep at least one round.",
      );
    }
    if (!round.lastRound) {
      throw new EvaluationStateError(
        "Only the final draft round in an evaluation plan can be deleted.",
      );
    }
    if (round.hasRunningAiAssessment) {
      throw new EvaluationStateError(
        "Wait for the running AI review assessment to finish before deleting this round.",
      );
    }
    if (round.hasActivity) {
      throw new EvaluationStateError(
        "A draft round with assignment, conflict, moderation, decision or AI-assessment activity cannot be deleted.",
      );
    }

    const operationId = crypto.randomUUID();
    const reviewerPlaceholders = expectedReviewerPersonIds
      .map(() => "?")
      .join(", ");
    const reviewerSnapshotGuard = `
      AND (SELECT COUNT(*) FROM evaluation_round_reviewers pool
            WHERE pool.event_id = deletable_round.event_id
              AND pool.round_id = deletable_round.id) = ?
      ${
        expectedReviewerPersonIds.length > 0
          ? `AND NOT EXISTS (
               SELECT 1 FROM evaluation_round_reviewers pool
                WHERE pool.event_id = deletable_round.event_id
                  AND pool.round_id = deletable_round.id
                  AND pool.person_id NOT IN (${reviewerPlaceholders})
             )`
          : ""
      }
    `;
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ?
           AND EXISTS (
             SELECT 1
               FROM evaluation_rounds deletable_round
               JOIN evaluation_plans plan
                 ON plan.id = deletable_round.plan_id
                AND plan.event_id = deletable_round.event_id
                AND plan.status IN ('draft','active')
              WHERE deletable_round.id = ?
                AND deletable_round.event_id = events.id
                AND deletable_round.status = 'draft'
                AND deletable_round.revision = ?
                AND plan.revision = ?
                AND (SELECT COUNT(*) FROM evaluation_rounds plan_round
                      WHERE plan_round.event_id = deletable_round.event_id
                        AND plan_round.plan_id = deletable_round.plan_id) > 1
                AND deletable_round.round_number = (
                  SELECT MAX(plan_round.round_number)
                    FROM evaluation_rounds plan_round
                   WHERE plan_round.event_id = deletable_round.event_id
                     AND plan_round.plan_id = deletable_round.plan_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM evaluator_assignments assignment
                   WHERE assignment.event_id = deletable_round.event_id
                     AND assignment.round_id = deletable_round.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM evaluator_conflicts conflict
                   WHERE conflict.event_id = deletable_round.event_id
                     AND conflict.round_id = deletable_round.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM review_moderations moderation
                   WHERE moderation.event_id = deletable_round.event_id
                     AND moderation.round_id = deletable_round.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM submission_decisions decision
                   WHERE decision.event_id = deletable_round.event_id
                     AND decision.round_id = deletable_round.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM ai_review_assessments assessment
                   WHERE assessment.event_id = deletable_round.event_id
                     AND assessment.round_id = deletable_round.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM operation_jobs operation
                   WHERE operation.event_id = deletable_round.event_id
                     AND operation.organisation_id = events.organisation_id
                     AND operation.type = 'ai.review_assessment.generate'
                     AND operation.status = 'running'
                     AND json_type(operation.payload_json, '$.roundId') = 'text'
                     AND json_extract(operation.payload_json, '$.roundId') = deletable_round.id
                )
                ${reviewerSnapshotGuard}
           )
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.roundId,
        parsed.roundRevision,
        parsed.planRevision,
        expectedReviewerPersonIds.length,
        ...expectedReviewerPersonIds,
      ),
      this.env.DB.prepare(
        `
        DELETE FROM evaluation_rounds
         WHERE id = ? AND event_id = ? AND plan_id = ?
           AND status = 'draft' AND revision = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ?
                AND last_operation_id = ?
           )
      `,
      ).bind(
        parsed.roundId,
        viewer.eventId,
        round.planId,
        parsed.roundRevision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_plans
           SET revision = revision + 1,
               blinded_reviewing = CASE WHEN EXISTS (
                 SELECT 1 FROM evaluation_rounds remaining_round
                  WHERE remaining_round.event_id = evaluation_plans.event_id
                    AND remaining_round.plan_id = evaluation_plans.id
                    AND remaining_round.blinded_reviewing = 1
               ) THEN 1 ELSE 0 END,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND NOT EXISTS (
             SELECT 1 FROM evaluation_rounds deleted_round
              WHERE deleted_round.id = ?
                AND deleted_round.event_id = evaluation_plans.event_id
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ?
                AND last_operation_id = ?
           )
      `,
      ).bind(
        round.planId,
        viewer.eventId,
        parsed.planRevision,
        parsed.roundId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'evaluation.round.deleted',
               'evaluation_round', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluation_plans plan
            WHERE plan.id = ? AND plan.event_id = ? AND plan.revision = ?
         )
           AND NOT EXISTS (
             SELECT 1 FROM evaluation_rounds deleted_round
              WHERE deleted_round.id = ? AND deleted_round.event_id = ?
           )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.roundId,
        JSON.stringify({
          name: round.name,
          roundNumber: round.roundNumber,
        }),
        round.planId,
        viewer.eventId,
        parsed.planRevision + 1,
        parsed.roundId,
        viewer.eventId,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      if (
        await hasRunningAiAssessmentForRound(
          this.env.DB,
          viewer.organisationId,
          viewer.eventId,
          parsed.roundId,
        )
      ) {
        throw new EvaluationStateError(
          "A running AI review assessment appeared before the round could be deleted. Wait for it to finish and try again.",
        );
      }
      throw new EvaluationRevisionConflictError(
        "The evaluation plan or round changed before it could be deleted.",
      );
    }
    if (
      (results[1]?.meta.changes ?? 0) < 1 ||
      (results[2]?.meta.changes ?? 0) !== 1 ||
      (results[3]?.meta.changes ?? 0) !== 1
    ) {
      throw new Error(
        "The confirmed evaluation round deletion did not commit completely.",
      );
    }
    return {
      roundId: parsed.roundId,
      planRevision: parsed.planRevision + 1,
    };
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
      parsed.toRoundId,
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
          JOIN evaluation_plans source_plan
            ON source_plan.id = source_round.plan_id
           AND source_plan.event_id = source_round.event_id
          JOIN evaluation_rounds target_round
            ON target_round.plan_id = source_round.plan_id
           AND target_round.event_id = source_round.event_id
           AND target_round.round_number = source_round.round_number + 1
         WHERE source_round.id = ? AND source_round.event_id = ?
           AND source_plan.status = 'active'
           AND source_round.status = 'active' AND source_round.revision = ?
           AND target_round.id = ? AND target_round.status = 'draft'
           AND target_round.revision = ?
           AND (target_round.closes_at IS NULL OR target_round.closes_at > unixepoch())
      )
      AND NOT EXISTS (
        SELECT 1 FROM evaluator_assignments unfinished
         WHERE unfinished.event_id = ? AND unfinished.round_id = ?
           AND unfinished.status IN ('assigned','in_progress','reopened')
           AND (
             (unfinished.submission_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM submissions submission
                WHERE submission.id = unfinished.submission_id
                  AND submission.event_id = unfinished.event_id
                  AND ${reviewableSubmissionSql("submission", "review")}
             ))
             OR (unfinished.session_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM sessions session
                WHERE session.id = unfinished.session_id
                  AND session.event_id = unfinished.event_id
                  AND session.status NOT IN ('cancelled','archived')
             ))
           )
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
          JOIN submissions submission
            ON submission.id = eligible.submission_id
           AND submission.event_id = eligible.event_id
         WHERE eligible.event_id = ? AND eligible.round_id = ?
           AND eligible.submission_id IN (${submissionPlaceholders})
           AND ${reviewableSubmissionSql("submission", "review")}
      ) = ?
      AND (
        SELECT COUNT(DISTINCT m.person_id) FROM memberships m
         WHERE m.event_id = ? AND m.accepted_at IS NOT NULL
           AND m.revoked_at IS NULL
           AND m.role IN ('evaluator','committee_chair')
           AND m.person_id IN (${evaluatorPlaceholders})
      ) = ?
      AND (
        SELECT COUNT(DISTINCT pool.person_id)
          FROM evaluation_round_reviewers pool
          JOIN events pool_event
            ON pool_event.id = pool.event_id
           AND pool_event.organisation_id = ?
         WHERE pool.event_id = ?
           AND pool.round_id = ?
           AND pool.person_id IN (${evaluatorPlaceholders})
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
          JOIN evaluation_round_reviewers pool
            ON pool.event_id = tm.event_id
           AND pool.round_id = ?
           AND pool.person_id = tm.person_id
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
      viewer.organisationId,
      viewer.eventId,
      parsed.toRoundId,
      ...evaluatorPersonIds,
      evaluatorPersonIds.length,
      ...(parsed.teamId
        ? [
            viewer.eventId,
            parsed.teamId,
            ...evaluatorPersonIds,
            evaluatorPersonIds.length,
            parsed.toRoundId,
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
        UPDATE evaluation_rounds SET status = 'active',
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
             SELECT COUNT(*) FROM evaluator_assignments committed_assignment
              WHERE committed_assignment.event_id = ?
                AND committed_assignment.round_id = ?
                AND committed_assignment.last_operation_id = ?
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
        parsed.toRoundId,
        operationId,
        result.assignmentCount,
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
