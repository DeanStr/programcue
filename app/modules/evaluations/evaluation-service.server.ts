import type { Viewer } from "~/platform/auth/authorize.server";
import { materializePublishedResourceAcknowledgementsForSession } from "~/modules/resources/resource-service.server";
import {
  reviewerVisibleAnswers,
  submittedSnapshotSchema,
} from "~/modules/submissions/submission-schema";
import { calculateWeightedScore } from "./evaluation-rules";
import {
  assignmentBatchSchema,
  conflictDeclarationSchema,
  decisionSchema,
  evaluationPlanSchema,
  reviewDraftSchema,
} from "./evaluation-schema";

type Criterion = {
  id: string;
  name: string;
  description: string | null;
  weightPercent: number;
  position: number;
};
type Round = {
  id: string;
  name: string;
  roundNumber: number;
  status: string;
  revision: number;
  anonymous: boolean;
  criteria: Criterion[];
};

function parseSubmittedSnapshot(snapshotJson: string | null) {
  let value: unknown;
  try {
    value = snapshotJson ? JSON.parse(snapshotJson) : null;
  } catch {
    value = null;
  }
  const snapshot = submittedSnapshotSchema.safeParse(value);
  return snapshot.success ? snapshot.data : null;
}

function requireSubmittedSnapshot(
  submissionId: string,
  snapshotJson: string | null,
) {
  const snapshot = parseSubmittedSnapshot(snapshotJson);
  if (!snapshot) {
    throw new Error(
      `Submission ${submissionId} is missing its valid immutable submitted snapshot.`,
    );
  }
  return snapshot;
}

function summaryAnswer(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export class EvaluationRevisionConflictError extends Error {
  constructor(
    message = "This review changed after it was loaded. Refresh before saving again.",
  ) {
    super(message);
    this.name = "EvaluationRevisionConflictError";
  }
}

export class EvaluationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationStateError";
  }
}

export class EvaluationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationValidationError";
  }
}

export class EvaluationDecisionFinalError extends Error {
  constructor() {
    super(
      "This submission already has a released decision. Released decisions are final until an explicit reopen workflow is implemented.",
    );
    this.name = "EvaluationDecisionFinalError";
  }
}

export class EvaluationDecisionAuthorityError extends Error {
  constructor() {
    super(
      "Only an administrator can release decisions unless the evaluation plan explicitly grants that authority to committee chairs.",
    );
    this.name = "EvaluationDecisionAuthorityError";
  }
}

export class EvaluationService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private async assertViewerEvent(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      "SELECT id FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first();
    if (!event)
      throw new Error("Event not found in the authorised organisation.");
  }

  async getAdminWorkspace(viewer: Viewer) {
    await this.assertViewerEvent(viewer);
    const [planRow, teamRows, evaluatorRows, submissionRows] =
      await Promise.all([
        this.env.DB.prepare(
          `
        SELECT p.id, p.name, p.status, p.revision,
               p.blinded_reviewing AS blindedReviewing,
               p.decision_role AS decisionRole
          FROM evaluation_plans p JOIN events e ON e.id = p.event_id
         WHERE p.event_id = ? AND e.organisation_id = ? AND p.status <> 'archived'
         ORDER BY p.created_at DESC LIMIT 1
      `,
        )
          .bind(viewer.eventId, viewer.organisationId)
          .first<{
            id: string;
            name: string;
            status: string;
            revision: number;
            blindedReviewing: number | boolean;
            decisionRole: "administrator" | "committee_chair";
          }>(),
        this.env.DB.prepare(
          `
        SELECT t.id, t.name, t.status, COUNT(tm.person_id) AS memberCount
          FROM evaluation_teams t
          LEFT JOIN evaluation_team_members tm ON tm.team_id = t.id AND tm.event_id = t.event_id AND tm.removed_at IS NULL
         WHERE t.event_id = ? GROUP BY t.id ORDER BY t.name
      `,
        )
          .bind(viewer.eventId)
          .all<{
            id: string;
            name: string;
            status: string;
            memberCount: number;
          }>(),
        this.env.DB.prepare(
          `
        SELECT DISTINCT p.id, p.display_name AS name, p.email, m.role
          FROM memberships m JOIN people p ON p.id = m.person_id
         WHERE m.event_id = ? AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
           AND m.role IN ('evaluator','committee_chair')
         ORDER BY p.display_name
      `,
        )
          .bind(viewer.eventId)
          .all<{ id: string; name: string; email: string; role: string }>(),
        this.env.DB.prepare(
          `
        SELECT s.id, s.public_reference AS reference, s.title, s.category, s.format, s.status,
               s.submitter_email AS submitterEmail,
               (SELECT COUNT(*) FROM submission_speakers ss
                 WHERE ss.event_id = s.event_id AND ss.submission_id = s.id
                   AND ss.person_id IS NULL) AS unclaimedSpeakerCount,
               COUNT(DISTINCT a.id) AS assignmentCount,
               COUNT(DISTINCT CASE WHEN a.status = 'submitted' THEN a.id END) AS completedReviewCount,
               AVG(r.weighted_score) AS averageScore
          FROM submissions s
          JOIN events e ON e.id = s.event_id
          LEFT JOIN evaluator_assignments a ON a.submission_id = s.id AND a.event_id = s.event_id
          LEFT JOIN reviews r ON r.assignment_id = a.id AND r.status IN ('submitted','locked')
         WHERE s.event_id = ? AND e.organisation_id = ? AND s.status <> 'draft'
         GROUP BY s.id ORDER BY s.updated_at DESC
      `,
        )
          .bind(viewer.eventId, viewer.organisationId)
          .all<{
            id: string;
            reference: string;
            title: string;
            category: string | null;
            format: string | null;
            status: string;
            submitterEmail: string | null;
            unclaimedSpeakerCount: number;
            assignmentCount: number;
            completedReviewCount: number;
            averageScore: number | null;
          }>(),
      ]);
    const rounds = planRow
      ? await this.getRounds(
          viewer.eventId,
          planRow.id,
          Boolean(planRow.blindedReviewing),
        )
      : [];
    return {
      plan: planRow
        ? {
            ...planRow,
            blindedReviewing: Boolean(planRow.blindedReviewing),
            rounds,
          }
        : null,
      teams: teamRows.results,
      evaluators: evaluatorRows.results,
      submissions: submissionRows.results,
    };
  }

  private async getRounds(
    eventId: string,
    planId: string,
    anonymous: boolean,
  ): Promise<Round[]> {
    const [roundRows, criterionRows] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT id, name, round_number AS roundNumber, status, revision
          FROM evaluation_rounds WHERE event_id = ? AND plan_id = ? ORDER BY round_number
      `,
      )
        .bind(eventId, planId)
        .all<Omit<Round, "criteria" | "anonymous">>(),
      this.env.DB.prepare(
        `
        SELECT c.id, c.round_id AS roundId, c.name, c.description,
               c.weight_percent AS weightPercent, c.position
          FROM evaluation_criteria c JOIN evaluation_rounds r ON r.id = c.round_id AND r.event_id = c.event_id
         WHERE c.event_id = ? AND r.plan_id = ? ORDER BY r.round_number, c.position
      `,
      )
        .bind(eventId, planId)
        .all<Criterion & { roundId: string }>(),
    ]);
    return roundRows.results.map((round) => ({
      ...round,
      anonymous,
      criteria: criterionRows.results.filter(
        (criterion) => criterion.roundId === round.id,
      ),
    }));
  }

  async savePlan(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    const parsed = evaluationPlanSchema.parse(input);
    const blindedReviewing = parsed.rounds[0].anonymous ? 1 : 0;
    const existing = await this.env.DB.prepare(
      `
      SELECT id, revision FROM evaluation_plans
       WHERE event_id = ? AND status <> 'archived' ORDER BY created_at DESC LIMIT 1
    `,
    )
      .bind(viewer.eventId)
      .first<{ id: string; revision: number }>();
    if (existing && existing.revision !== parsed.revision)
      throw new EvaluationRevisionConflictError(
        "The evaluation plan changed after it was loaded.",
      );
    if (existing) {
      const assignment = await this.env.DB.prepare(
        `
        SELECT a.id FROM evaluator_assignments a JOIN evaluation_rounds r ON r.id = a.round_id
         WHERE r.plan_id = ? LIMIT 1
      `,
      )
        .bind(existing.id)
        .first();
      if (assignment)
        throw new EvaluationStateError(
          "A plan with assignments cannot have its rounds or rubric replaced. Create the next round instead.",
        );
    }
    const planId = existing?.id ?? crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const planHasNoAssignments = `
      NOT EXISTS (
        SELECT 1
          FROM evaluator_assignments assignment
          JOIN evaluation_rounds assigned_round
            ON assigned_round.id = assignment.round_id
           AND assigned_round.event_id = assignment.event_id
         WHERE assigned_round.plan_id = ?
           AND assigned_round.event_id = ?
      )
    `;
    const statements: D1PreparedStatement[] = [
      existing
        ? this.env.DB.prepare(
            `
            UPDATE events
               SET last_operation_id = ?, updated_at = unixepoch()
             WHERE id = ? AND organisation_id = ?
               AND EXISTS (
                 SELECT 1 FROM evaluation_plans plan
                  WHERE plan.id = ? AND plan.event_id = events.id
                    AND plan.revision = ? AND ${planHasNoAssignments}
               )
          `,
          ).bind(
            operationId,
            viewer.eventId,
            viewer.organisationId,
            planId,
            parsed.revision,
            planId,
            viewer.eventId,
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
          `,
          ).bind(operationId, viewer.eventId, viewer.organisationId),
      ...(existing
        ? [
            this.env.DB.prepare(
              `
        UPDATE evaluation_plans SET name = ?, status = ?, blinded_reviewing = ?, revision = revision + 1,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND ${planHasNoAssignments}
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
            ).bind(
              parsed.name,
              parsed.status,
              blindedReviewing,
              planId,
              viewer.eventId,
              parsed.revision,
              planId,
              viewer.eventId,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            ),
            this.env.DB.prepare(
              `
        DELETE FROM evaluation_rounds
         WHERE plan_id = ? AND event_id = ?
           AND ${planHasNoAssignments}
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
              planId,
              viewer.eventId,
              planId,
              viewer.eventId,
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
          id, event_id, name, status, blinded_reviewing, revision,
          created_by_person_id, created_at, updated_at
        ) SELECT ?, e.id, ?, ?, ?, 1, ?, unixepoch(), unixepoch()
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
              viewer.personId,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            ),
          ]),
    ];
    for (const [roundIndex, round] of parsed.rounds.entries()) {
      statements.push(
        this.env.DB.prepare(
          `
        INSERT INTO evaluation_rounds (
          id, event_id, plan_id, round_number, name, status, closes_at,
          advancement_rule_json, revision, created_at, updated_at
        )
        SELECT ?, p.event_id, p.id, ?, ?, ?, ?, '{}', 1, unixepoch(), unixepoch()
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
          round.dueAt ? Math.floor(Date.parse(round.dueAt) / 1_000) : null,
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
            id, event_id, round_id, name, description, input_type, weight_percent, required, position
          )
          SELECT ?, r.event_id, r.id, ?, ?, 'scale_5', ?, 1, ?
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
            criterion.weightPercent,
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
    }
    statements.push(
      this.env.DB.prepare(
        `
      INSERT INTO audit_events (
        id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
      )
      SELECT ?, ?, ?, ?, 'evaluation.plan.saved', 'evaluation_plan', ?, ?, unixepoch()
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
        viewer.personId,
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
    const [claimed] = await this.env.DB.batch(statements);
    if ((claimed.meta.changes ?? 0) !== 1) {
      if (existing) {
        const assignment = await this.env.DB.prepare(
          `
          SELECT a.id FROM evaluator_assignments a
          JOIN evaluation_rounds r
            ON r.id = a.round_id AND r.event_id = a.event_id
         WHERE r.plan_id = ? AND r.event_id = ? LIMIT 1
        `,
        )
          .bind(existing.id, viewer.eventId)
          .first();
        if (assignment) {
          throw new EvaluationStateError(
            "A plan with assignments cannot have its rounds or rubric replaced. Create the next round instead.",
          );
        }
      }
      throw new EvaluationRevisionConflictError(
        "The evaluation plan changed after it was loaded.",
      );
    }
    return planId;
  }

  async assign(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    const parsed = assignmentBatchSchema.parse(input);
    const round = await this.env.DB.prepare(
      `
      SELECT r.id FROM evaluation_rounds r JOIN evaluation_plans p ON p.id = r.plan_id AND p.event_id = r.event_id
      JOIN events e ON e.id = r.event_id WHERE r.id = ? AND r.event_id = ? AND e.organisation_id = ? AND r.status = 'active'
    `,
    )
      .bind(parsed.roundId, viewer.eventId, viewer.organisationId)
      .first();
    if (!round)
      throw new EvaluationStateError("Active evaluation round not found.");
    const validSubmissions = await this.env.DB.prepare(
      `SELECT id FROM submissions WHERE event_id = ? AND id IN (${parsed.submissionIds.map(() => "?").join(",")}) AND status IN ('submitted','assigned','in_review')`,
    )
      .bind(viewer.eventId, ...parsed.submissionIds)
      .all<{ id: string }>();
    if (validSubmissions.results.length !== parsed.submissionIds.length)
      throw new EvaluationStateError(
        "One or more submissions cannot be assigned.",
      );
    const validEvaluators = await this.env.DB.prepare(
      `SELECT DISTINCT person_id AS id FROM memberships WHERE event_id = ? AND accepted_at IS NOT NULL AND revoked_at IS NULL AND role IN ('evaluator','committee_chair') AND person_id IN (${parsed.evaluatorPersonIds.map(() => "?").join(",")})`,
    )
      .bind(viewer.eventId, ...parsed.evaluatorPersonIds)
      .all<{ id: string }>();
    if (validEvaluators.results.length !== parsed.evaluatorPersonIds.length)
      throw new EvaluationStateError(
        "One or more evaluators are not authorised for this event.",
      );
    const operationId = crypto.randomUUID();
    const submissionPlaceholders = parsed.submissionIds
      .map(() => "?")
      .join(",");
    const evaluatorPlaceholders = parsed.evaluatorPersonIds
      .map(() => "?")
      .join(",");
    const eligibilitySql = `
      EXISTS (
        SELECT 1
          FROM evaluation_rounds current_round
          JOIN evaluation_plans current_plan
            ON current_plan.id = current_round.plan_id
           AND current_plan.event_id = current_round.event_id
          JOIN events current_event ON current_event.id = current_round.event_id
         WHERE current_round.id = ? AND current_round.event_id = ?
           AND current_event.organisation_id = ? AND current_round.status = 'active'
      )
      AND (
        SELECT COUNT(*) FROM submissions current_submission
         WHERE current_submission.event_id = ?
           AND current_submission.id IN (${submissionPlaceholders})
           AND current_submission.status IN ('submitted','assigned','in_review')
      ) = ?
      AND (
        SELECT COUNT(DISTINCT current_membership.person_id)
          FROM memberships current_membership
         WHERE current_membership.event_id = ?
           AND current_membership.accepted_at IS NOT NULL
           AND current_membership.revoked_at IS NULL
           AND current_membership.role IN ('evaluator','committee_chair')
           AND current_membership.person_id IN (${evaluatorPlaceholders})
      ) = ?
      AND NOT EXISTS (
        SELECT 1 FROM evaluator_assignments blocked_assignment
         WHERE blocked_assignment.event_id = ?
           AND blocked_assignment.round_id = ?
           AND blocked_assignment.submission_id IN (${submissionPlaceholders})
           AND blocked_assignment.evaluator_person_id IN (${evaluatorPlaceholders})
           AND blocked_assignment.status IN ('recused','cancelled')
      )
    `;
    const eligibilityBindings = [
      parsed.roundId,
      viewer.eventId,
      viewer.organisationId,
      viewer.eventId,
      ...parsed.submissionIds,
      parsed.submissionIds.length,
      viewer.eventId,
      ...parsed.evaluatorPersonIds,
      parsed.evaluatorPersonIds.length,
      viewer.eventId,
      parsed.roundId,
      ...parsed.submissionIds,
      ...parsed.evaluatorPersonIds,
    ];
    const coverageSql = `
      (
        SELECT COUNT(*) FROM evaluator_assignments requested_assignment
         WHERE requested_assignment.event_id = ?
           AND requested_assignment.round_id = ?
           AND requested_assignment.submission_id IN (${submissionPlaceholders})
           AND requested_assignment.evaluator_person_id IN (${evaluatorPlaceholders})
           AND requested_assignment.status NOT IN ('recused','cancelled')
      ) = ?
    `;
    const coverageBindings = [
      viewer.eventId,
      parsed.roundId,
      ...parsed.submissionIds,
      ...parsed.evaluatorPersonIds,
      parsed.submissionIds.length * parsed.evaluatorPersonIds.length,
    ];
    const statements: D1PreparedStatement[] = [];
    for (const submissionId of parsed.submissionIds)
      for (const evaluatorId of parsed.evaluatorPersonIds) {
        statements.push(
          this.env.DB.prepare(
            `
        INSERT INTO evaluator_assignments (
          id, event_id, round_id, submission_id, evaluator_person_id, status,
          revision, last_operation_id, assigned_at
        )
        SELECT ?, ?, ?, ?, ?, 'assigned', 1, ?, unixepoch()
         WHERE ${eligibilitySql}
        ON CONFLICT(round_id, submission_id, evaluator_person_id) DO NOTHING
      `,
          ).bind(
            crypto.randomUUID(),
            viewer.eventId,
            parsed.roundId,
            submissionId,
            evaluatorId,
            operationId,
            ...eligibilityBindings,
          ),
        );
      }
    statements.push(
      this.env.DB.prepare(
        `
      UPDATE submissions
         SET status = 'assigned', revision = revision + 1,
             last_operation_id = ?, updated_at = unixepoch()
       WHERE event_id = ? AND id IN (${submissionPlaceholders})
         AND status = 'submitted'
         AND ${eligibilitySql}
         AND ${coverageSql}
    `,
      ).bind(
        operationId,
        viewer.eventId,
        ...parsed.submissionIds,
        ...eligibilityBindings,
        ...coverageBindings,
      ),
    );
    statements.push(
      this.env.DB.prepare(
        `
      INSERT INTO audit_events (
        id, organisation_id, event_id, actor_person_id, action,
        entity_type, metadata_json, created_at
      )
      SELECT ?, ?, ?, ?, 'evaluation.assignments.created',
             'evaluator_assignment', ?, unixepoch()
       WHERE ${eligibilitySql} AND ${coverageSql}
    `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        JSON.stringify({
          submissionCount: parsed.submissionIds.length,
          evaluatorCount: parsed.evaluatorPersonIds.length,
        }),
        ...eligibilityBindings,
        ...coverageBindings,
      ),
    );
    statements.push(
      this.env.DB.prepare(
        `
      SELECT CASE WHEN ${eligibilitySql} AND ${coverageSql}
                  THEN 1 ELSE 0 END AS valid
    `,
      ).bind(...eligibilityBindings, ...coverageBindings),
    );
    const results = await this.env.DB.batch(statements);
    const validation = results.at(-1)?.results?.[0] as
      { valid?: number | boolean } | undefined;
    if (Number(validation?.valid ?? 0) !== 1) {
      throw new EvaluationRevisionConflictError(
        "The round, submissions, or evaluators changed before the assignments were created. Refresh before trying again.",
      );
    }
  }

  async getReviewerWorkspace(viewer: Viewer, selectedAssignmentId?: string) {
    await this.assertViewerEvent(viewer);
    const assignments = await this.env.DB.prepare(
      `
      SELECT a.id, a.status, a.revision, a.due_at AS dueAt, s.id AS submissionId,
             s.public_reference AS reference, s.title, s.category, s.format,
             s.submitted_snapshot_json AS snapshotJson,
             p.blinded_reviewing AS blindedReviewing
        FROM evaluator_assignments a
        JOIN submissions s ON s.id = a.submission_id AND s.event_id = a.event_id
        JOIN evaluation_rounds r ON r.id = a.round_id AND r.event_id = a.event_id
        JOIN evaluation_plans p ON p.id = r.plan_id AND p.event_id = r.event_id
       WHERE a.event_id = ? AND a.evaluator_person_id = ?
         AND a.status NOT IN ('recused','cancelled')
       ORDER BY CASE a.status WHEN 'in_progress' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END, a.due_at, a.assigned_at
    `,
    )
      .bind(viewer.eventId, viewer.personId)
      .all<{
        id: string;
        status: string;
        revision: number;
        dueAt: number | null;
        submissionId: string;
        reference: string;
        title: string;
        category: string | null;
        format: string | null;
        snapshotJson: string | null;
        blindedReviewing: number | boolean;
      }>();
    const reviewerAssignments = assignments.results.map(
      ({ snapshotJson, ...assignment }) => {
        const blindedReviewing = Boolean(assignment.blindedReviewing);
        if (!blindedReviewing) return { ...assignment, blindedReviewing };
        const snapshot = parseSubmittedSnapshot(snapshotJson);
        if (!snapshot) {
          return {
            ...assignment,
            title: "Blinded proposal",
            category: null,
            format: null,
            blindedReviewing,
          };
        }
        const answers = reviewerVisibleAnswers(
          snapshot.schema,
          snapshot.answers,
        );
        return {
          ...assignment,
          title: summaryAnswer(answers.title) ?? "Blinded proposal",
          category: summaryAnswer(answers.category),
          format: summaryAnswer(answers.format),
          blindedReviewing,
        };
      },
    );
    const selected =
      selectedAssignmentId === undefined
        ? (reviewerAssignments[0] ?? null)
        : (reviewerAssignments.find(
            (assignment) => assignment.id === selectedAssignmentId,
          ) ?? null);
    if (selectedAssignmentId !== undefined && !selected) {
      throw new Response("Review assignment not found", { status: 404 });
    }
    if (!selected)
      return {
        assignments: [],
        selected: null,
        criteria: [],
        submission: null,
        review: null,
      };
    const [criteria, submission, review] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT c.id, c.name, c.description, c.weight_percent AS weightPercent, c.position
          FROM evaluation_criteria c JOIN evaluator_assignments a ON a.round_id = c.round_id AND a.event_id = c.event_id
         WHERE a.id = ? AND a.event_id = ? ORDER BY c.position
      `,
      )
        .bind(selected.id, viewer.eventId)
        .all<Criterion>(),
      this.env.DB.prepare(
        `
        SELECT s.id, s.title, s.category, s.format,
               s.submitted_snapshot_json AS snapshotJson, s.submitter_email AS submitterEmail,
               GROUP_CONCAT(ss.display_name, '||') AS speakerNames
          FROM evaluator_assignments a JOIN submissions s ON s.id = a.submission_id AND s.event_id = a.event_id
          LEFT JOIN submission_speakers ss ON ss.submission_id = s.id AND ss.event_id = s.event_id
         WHERE a.id = ? AND a.event_id = ? AND a.evaluator_person_id = ? GROUP BY s.id
      `,
      )
        .bind(selected.id, viewer.eventId, viewer.personId)
        .first<{
          id: string;
          title: string;
          category: string | null;
          format: string | null;
          snapshotJson: string | null;
          submitterEmail: string | null;
          speakerNames: string | null;
        }>(),
      this.env.DB.prepare(
        `
        SELECT r.id, r.status, r.scores_json AS scoresJson, r.weighted_score AS weightedScore,
               r.recommendation, r.confidence, r.submitter_feedback AS submitterFeedback,
               r.private_notes AS privateNotes, r.revision
          FROM reviews r JOIN evaluator_assignments a ON a.id = r.assignment_id AND a.event_id = r.event_id
         WHERE r.assignment_id = ? AND r.event_id = ? AND a.evaluator_person_id = ?
      `,
      )
        .bind(selected.id, viewer.eventId, viewer.personId)
        .first<{
          id: string;
          status: string;
          scoresJson: string;
          weightedScore: number | null;
          recommendation: string | null;
          confidence: number | null;
          submitterFeedback: string | null;
          privateNotes: string | null;
          revision: number;
        }>(),
    ]);
    const snapshot = submission
      ? requireSubmittedSnapshot(submission.id, submission.snapshotJson)
      : null;
    const answers =
      snapshot && selected.blindedReviewing
        ? reviewerVisibleAnswers(snapshot.schema, snapshot.answers)
        : snapshot?.answers;
    const submissionView =
      submission && snapshot && answers
        ? {
            id: submission.id,
            title: selected.blindedReviewing
              ? (summaryAnswer(answers.title) ?? "Blinded proposal")
              : submission.title,
            category: selected.blindedReviewing
              ? summaryAnswer(answers.category)
              : submission.category,
            format: selected.blindedReviewing
              ? summaryAnswer(answers.format)
              : submission.format,
            answers,
            blindedReviewing: Boolean(selected.blindedReviewing),
            submitterEmail: selected.blindedReviewing
              ? null
              : submission.submitterEmail,
            speakerNames: selected.blindedReviewing
              ? []
              : (submission.speakerNames?.split("||") ?? []),
          }
        : null;
    return {
      assignments: reviewerAssignments,
      selected,
      criteria: criteria.results,
      submission: submissionView,
      review: review
        ? {
            ...review,
            scores: JSON.parse(review.scoresJson) as Record<string, number>,
          }
        : null,
    };
  }

  async saveReview(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    const parsed = reviewDraftSchema.parse(input);
    const assignment = await this.env.DB.prepare(
      `
      SELECT a.id, a.status, a.revision, a.submission_id AS submissionId, a.round_id AS roundId
        FROM evaluator_assignments a
        JOIN evaluation_rounds r ON r.id = a.round_id AND r.event_id = a.event_id
        JOIN submissions s ON s.id = a.submission_id AND s.event_id = a.event_id
       WHERE a.id = ? AND a.event_id = ? AND a.evaluator_person_id = ? AND a.status IN ('assigned','in_progress','reopened') AND r.status = 'active'
         AND s.status IN ('submitted','assigned','in_review','decision_ready')
    `,
    )
      .bind(parsed.assignmentId, viewer.eventId, viewer.personId)
      .first<{
        id: string;
        status: string;
        revision: number;
        submissionId: string;
        roundId: string;
      }>();
    if (!assignment)
      throw new EvaluationStateError(
        "This assignment is unavailable or already submitted.",
      );
    const criteria = await this.env.DB.prepare(
      `SELECT id, weight_percent AS weightPercent FROM evaluation_criteria WHERE event_id = ? AND round_id = ? ORDER BY position`,
    )
      .bind(viewer.eventId, assignment.roundId)
      .all<{ id: string; weightPercent: number }>();
    const criterionIds = new Set(
      criteria.results.map((criterion) => criterion.id),
    );
    const unknownScoreIds = Object.keys(parsed.scores).filter(
      (criterionId) => !criterionIds.has(criterionId),
    );
    if (unknownScoreIds.length) {
      throw new EvaluationValidationError(
        "The review contains scores for criteria that are not in this evaluation round. Refresh before saving.",
      );
    }
    if (
      parsed.intent === "submit" &&
      criteria.results.some((criterion) => !(criterion.id in parsed.scores))
    ) {
      throw new EvaluationValidationError(
        "Score every criterion before submitting the review.",
      );
    }
    const weightedScore =
      parsed.intent === "submit"
        ? calculateWeightedScore(criteria.results, parsed.scores)
        : null;
    const existing = await this.env.DB.prepare(
      "SELECT id, revision, status FROM reviews WHERE event_id = ? AND assignment_id = ?",
    )
      .bind(viewer.eventId, assignment.id)
      .first<{ id: string; revision: number; status: string }>();
    if ((existing?.revision ?? 0) !== parsed.revision)
      throw new EvaluationRevisionConflictError();
    const reviewId = existing?.id ?? crypto.randomUUID();
    const nextRevision = parsed.revision + 1;
    const operationId = crypto.randomUUID();
    const status = parsed.intent === "submit" ? "submitted" : "draft";
    const reviewMutation = existing
      ? this.env.DB.prepare(
          `
      UPDATE reviews SET status = ?, scores_json = ?, weighted_score = ?, recommendation = ?, confidence = ?,
             submitter_feedback = ?, private_notes = ?, revision = revision + 1, last_operation_id = ?,
             updated_at = unixepoch(), submitted_at = CASE WHEN ? = 'submitted' THEN unixepoch() ELSE submitted_at END,
             locked_at = CASE WHEN ? = 'submitted' THEN unixepoch() ELSE locked_at END
       WHERE id = ? AND event_id = ? AND revision = ? AND status IN ('draft','reopened')
         AND EXISTS (
           SELECT 1 FROM evaluator_assignments assignment
           JOIN submissions active_submission
             ON active_submission.id = assignment.submission_id
            AND active_submission.event_id = assignment.event_id
            WHERE assignment.id = ? AND assignment.event_id = ?
              AND assignment.evaluator_person_id = ? AND assignment.revision = ?
              AND assignment.status IN ('assigned','in_progress','reopened')
              AND active_submission.status IN ('submitted','assigned','in_review','decision_ready')
         )
    `,
        ).bind(
          status,
          JSON.stringify(parsed.scores),
          weightedScore,
          parsed.recommendation,
          parsed.confidence,
          parsed.submitterFeedback || null,
          parsed.privateNotes || null,
          operationId,
          status,
          status,
          reviewId,
          viewer.eventId,
          parsed.revision,
          assignment.id,
          viewer.eventId,
          viewer.personId,
          assignment.revision,
        )
      : this.env.DB.prepare(
          `
      INSERT INTO reviews (id, event_id, assignment_id, status, scores_json, weighted_score, recommendation, confidence, submitter_feedback, private_notes, revision, last_operation_id, created_at, updated_at, submitted_at, locked_at)
      SELECT ?, ?, assignment.id, ?, ?, ?, ?, ?, ?, ?, 1, ?, unixepoch(), unixepoch(),
             CASE WHEN ? = 'submitted' THEN unixepoch() END,
             CASE WHEN ? = 'submitted' THEN unixepoch() END
        FROM evaluator_assignments assignment
        JOIN submissions active_submission
          ON active_submission.id = assignment.submission_id
         AND active_submission.event_id = assignment.event_id
       WHERE assignment.id = ? AND assignment.event_id = ?
         AND assignment.evaluator_person_id = ? AND assignment.revision = ?
         AND assignment.status IN ('assigned','in_progress','reopened')
         AND active_submission.status IN ('submitted','assigned','in_review','decision_ready')
    `,
        ).bind(
          reviewId,
          viewer.eventId,
          status,
          JSON.stringify(parsed.scores),
          weightedScore,
          parsed.recommendation,
          parsed.confidence,
          parsed.submitterFeedback || null,
          parsed.privateNotes || null,
          operationId,
          status,
          status,
          assignment.id,
          viewer.eventId,
          viewer.personId,
          assignment.revision,
        );
    const [saved, assignmentUpdated] = await this.env.DB.batch([
      reviewMutation,
      this.env.DB.prepare(
        `
        UPDATE evaluator_assignments
           SET status = ?, revision = revision + 1, last_operation_id = ?,
               submitted_at = CASE WHEN ? = 'submitted' THEN unixepoch() ELSE submitted_at END
         WHERE id = ? AND event_id = ? AND evaluator_person_id = ? AND revision = ?
           AND status IN ('assigned','in_progress','reopened')
           AND EXISTS (SELECT 1 FROM reviews WHERE id = ? AND last_operation_id = ?)
      `,
      ).bind(
        parsed.intent === "submit" ? "submitted" : "in_progress",
        operationId,
        status,
        assignment.id,
        viewer.eventId,
        viewer.personId,
        assignment.revision,
        reviewId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO review_revisions (id, event_id, review_id, revision_number, scores_json, content_json, save_kind, saved_by_person_id, idempotency_key, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ? AND last_operation_id = ?)
           AND EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND last_operation_id = ?)
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.eventId,
        reviewId,
        nextRevision,
        JSON.stringify(parsed.scores),
        JSON.stringify({
          recommendation: parsed.recommendation,
          confidence: parsed.confidence,
          submitterFeedback: parsed.submitterFeedback,
          privateNotes: parsed.privateNotes,
        }),
        parsed.intent === "submit" ? "submitted" : "manual",
        viewer.personId,
        operationId,
        reviewId,
        operationId,
        assignment.id,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE submissions SET status = 'in_review', revision = revision + 1, updated_at = unixepoch() WHERE id = ? AND event_id = ? AND status IN ('assigned','submitted') AND EXISTS (SELECT 1 FROM reviews WHERE id = ? AND last_operation_id = ?) AND EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND last_operation_id = ?)`,
      ).bind(
        assignment.submissionId,
        viewer.eventId,
        reviewId,
        operationId,
        assignment.id,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at) SELECT ?, ?, ?, ?, ?, 'review', ?, ?, unixepoch() WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ? AND last_operation_id = ?) AND EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND last_operation_id = ?)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.intent === "submit" ? "review.submitted" : "review.saved",
        reviewId,
        JSON.stringify({ revision: nextRevision }),
        reviewId,
        operationId,
        assignment.id,
        operationId,
      ),
    ]);
    if (
      (saved.meta.changes ?? 0) !== 1 ||
      (assignmentUpdated.meta.changes ?? 0) !== 1
    )
      throw new EvaluationRevisionConflictError();
    return { reviewId, revision: nextRevision, weightedScore };
  }

  async declareConflict(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    const parsed = conflictDeclarationSchema.parse(input);
    const assignment = await this.env.DB.prepare(
      `SELECT id, revision, round_id AS roundId, submission_id AS submissionId FROM evaluator_assignments WHERE id = ? AND event_id = ? AND evaluator_person_id = ? AND status IN ('assigned','in_progress')`,
    )
      .bind(parsed.assignmentId, viewer.eventId, viewer.personId)
      .first<{
        id: string;
        revision: number;
        roundId: string;
        submissionId: string;
      }>();
    if (!assignment)
      throw new EvaluationStateError(
        "Assignment not found or cannot be recused.",
      );
    const operationId = crypto.randomUUID();
    const [recused] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE evaluator_assignments
           SET status = 'recused', conflict_declared_at = unixepoch(),
               revision = revision + 1, last_operation_id = ?
         WHERE id = ? AND event_id = ? AND evaluator_person_id = ?
           AND revision = ? AND status IN ('assigned','in_progress')
      `,
      ).bind(
        operationId,
        assignment.id,
        viewer.eventId,
        viewer.personId,
        assignment.revision,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO evaluator_conflicts (
          id, event_id, round_id, submission_id, evaluator_person_id,
          relationship, notes, status, declared_at
        )
        SELECT ?, ?, ?, ?, ?, 'declared', ?, 'recused', unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluator_assignments
            WHERE id = ? AND event_id = ? AND last_operation_id = ?
         )
        ON CONFLICT(round_id, submission_id, evaluator_person_id) DO UPDATE SET
          notes = excluded.notes, status = 'recused', declared_at = unixepoch()
        WHERE EXISTS (
          SELECT 1 FROM evaluator_assignments
           WHERE id = ? AND event_id = ? AND last_operation_id = ?
        )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.eventId,
        assignment.roundId,
        assignment.submissionId,
        viewer.personId,
        parsed.reason,
        assignment.id,
        viewer.eventId,
        operationId,
        assignment.id,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at) SELECT ?, ?, ?, ?, 'review.conflict.declared', 'evaluator_assignment', ?, '{}', unixepoch() WHERE EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND event_id = ? AND last_operation_id = ?)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        assignment.id,
        assignment.id,
        viewer.eventId,
        operationId,
      ),
    ]);
    if ((recused.meta.changes ?? 0) !== 1) {
      throw new EvaluationRevisionConflictError(
        "This assignment changed before the conflict could be recorded.",
      );
    }
  }

  async decide(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    const parsed = decisionSchema.parse(input);
    if (
      parsed.release &&
      viewer.role !== "owner" &&
      viewer.role !== "administrator"
    ) {
      const plan = await this.env.DB.prepare(
        `
        SELECT decision_role AS decisionRole
          FROM evaluation_plans
         WHERE event_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 1
      `,
      )
        .bind(viewer.eventId)
        .first<{ decisionRole: string }>();
      if (
        viewer.role !== "committee_chair" ||
        plan?.decisionRole !== "committee_chair"
      ) {
        throw new EvaluationDecisionAuthorityError();
      }
    }
    const submission = await this.env.DB.prepare(
      `
      SELECT s.id, s.title, s.public_reference AS reference, s.format, s.category,
             s.status, s.revision, s.submitted_snapshot_json AS snapshotJson
        FROM submissions s JOIN events e ON e.id = s.event_id
       WHERE s.id = ? AND s.event_id = ? AND e.organisation_id = ? AND s.status NOT IN ('draft','withdrawn')
    `,
    )
      .bind(parsed.submissionId, viewer.eventId, viewer.organisationId)
      .first<{
        id: string;
        title: string;
        reference: string;
        format: string | null;
        category: string | null;
        status: string;
        revision: number;
        snapshotJson: string | null;
      }>();
    if (!submission)
      throw new EvaluationStateError(
        "Submission not found or cannot be decided.",
      );
    const terminalStatuses = new Set(["accepted", "waitlisted", "rejected"]);
    const prior = await this.env.DB.prepare(
      `
      SELECT COALESCE(MAX(revision_number), 0) AS revision,
             COALESCE(MAX(CASE WHEN status = 'published' THEN 1 ELSE 0 END), 0) AS hasPublished
        FROM submission_decisions WHERE event_id = ? AND submission_id = ?
    `,
    )
      .bind(viewer.eventId, submission.id)
      .first<{ revision: number; hasPublished: number }>();
    if (
      terminalStatuses.has(submission.status) ||
      Number(prior?.hasPublished ?? 0) > 0
    ) {
      throw new EvaluationDecisionFinalError();
    }
    const revision = (prior?.revision ?? 0) + 1;
    const decisionId = crypto.randomUUID();
    const sessionId =
      parsed.release && parsed.decision === "accepted"
        ? crypto.randomUUID()
        : null;
    let sessionDescription = "";
    if (sessionId) {
      let rawSnapshot: unknown;
      try {
        rawSnapshot = JSON.parse(submission.snapshotJson ?? "null");
      } catch {
        rawSnapshot = null;
      }
      const snapshot = submittedSnapshotSchema.safeParse(rawSnapshot);
      if (!snapshot.success) {
        throw new EvaluationStateError(
          "The accepted submission is missing its valid immutable snapshot.",
        );
      }
      const description = snapshot.data.answers.description;
      sessionDescription =
        typeof description === "string" ? description.trim() : "";
    }
    const notificationOperationId = parsed.release ? crypto.randomUUID() : null;
    const status = parsed.release ? "published" : "draft";
    const submissionStatus = parsed.release
      ? parsed.decision
      : "decision_ready";
    const slug = `${
      submission.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || "session"
    }-${submission.reference.toLowerCase()}`;
    const allowedFormats = new Set([
      "keynote",
      "presentation",
      "panel",
      "workshop",
      "breakout",
      "break",
      "other",
    ]);
    const format = allowedFormats.has((submission.format ?? "").toLowerCase())
      ? submission.format!.toLowerCase()
      : "other";
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE submissions
           SET status = ?, revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND status IN ('submitted','assigned','in_review','decision_ready')
           AND (
             ? <> 'published' OR ? <> 'accepted'
             OR NOT EXISTS (
               SELECT 1 FROM submission_speakers pending_speaker
                WHERE pending_speaker.event_id = submissions.event_id
                  AND pending_speaker.submission_id = submissions.id
                  AND pending_speaker.person_id IS NULL
             )
           )
           AND (
             ? <> 'published'
             OR ? IN ('owner','administrator')
             OR (
               ? = 'committee_chair'
               AND EXISTS (
                 SELECT 1 FROM evaluation_plans authority_plan
                  WHERE authority_plan.event_id = submissions.event_id
                    AND authority_plan.status = 'active'
                    AND authority_plan.decision_role = 'committee_chair'
               )
             )
           )
      `,
      ).bind(
        submissionStatus,
        decisionId,
        submission.id,
        viewer.eventId,
        submission.revision,
        status,
        parsed.decision,
        status,
        viewer.role,
        viewer.role,
      ),
      this.env.DB.prepare(
        `
        UPDATE submission_decisions SET status = 'superseded'
         WHERE event_id = ? AND submission_id = ? AND status = 'draft'
           AND EXISTS (
             SELECT 1 FROM submissions
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        submission.id,
        submission.id,
        viewer.eventId,
        decisionId,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluator_assignments
           SET status = 'cancelled', revision = revision + 1,
               last_operation_id = ?
         WHERE event_id = ? AND submission_id = ?
           AND status IN ('assigned','in_progress','reopened')
           AND ? = 'published'
           AND EXISTS (
             SELECT 1 FROM submissions
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        decisionId,
        viewer.eventId,
        submission.id,
        status,
        submission.id,
        viewer.eventId,
        decisionId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO submission_decisions (
          id, event_id, submission_id, revision_number, status, decision,
          decided_by_person_id, rationale, effect_preview_json, idempotency_key,
          decided_at, published_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(),
               CASE WHEN ? = 'published' THEN unixepoch() END
         WHERE EXISTS (
           SELECT 1 FROM submissions
            WHERE id = ? AND event_id = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        decisionId,
        viewer.eventId,
        submission.id,
        revision,
        status,
        parsed.decision,
        viewer.personId,
        parsed.rationale || null,
        JSON.stringify({
          createsSession: Boolean(sessionId),
          queuesNotification: Boolean(notificationOperationId),
        }),
        `decision:${submission.id}:${revision}`,
        status,
        submission.id,
        viewer.eventId,
        decisionId,
      ),
      ...(sessionId
        ? [
            this.env.DB.prepare(
              `
          INSERT INTO sessions (
            id, event_id, source_submission_id, title, slug, description, format,
            duration_minutes, status, visibility, revision, created_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, 60, 'unscheduled', 'public', 1, unixepoch(), unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM submission_decisions
              WHERE id = ? AND event_id = ? AND status = 'published' AND decision = 'accepted'
           )
        `,
            ).bind(
              sessionId,
              viewer.eventId,
              submission.id,
              submission.title,
              slug,
              sessionDescription,
              format,
              decisionId,
              viewer.eventId,
            ),
            this.env.DB.prepare(
              `
          INSERT INTO session_speakers (session_id, event_id, person_id, position, role_label, visibility)
          SELECT ?, event_id, person_id, position,
                 CASE WHEN is_primary = 1 THEN 'Primary speaker' ELSE 'Co-speaker' END, 'public'
            FROM submission_speakers
           WHERE submission_id = ? AND event_id = ? AND person_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND event_id = ?)
        `,
            ).bind(
              sessionId,
              submission.id,
              viewer.eventId,
              sessionId,
              viewer.eventId,
            ),
            ...materializePublishedResourceAcknowledgementsForSession(
              this.env,
              viewer.eventId,
              sessionId,
            ),
          ]
        : []),
      ...(notificationOperationId
        ? [
            this.env.DB.prepare(
              `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json,
          progress_completed, progress_total, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'decision.notification', ?, ?, 'queued', ?, 0, 1, unixepoch(), unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM submission_decisions
            WHERE id = ? AND event_id = ? AND status = 'published'
         )
      `,
            ).bind(
              notificationOperationId,
              viewer.organisationId,
              viewer.eventId,
              viewer.personId,
              `decision-notification:${decisionId}`,
              crypto.randomUUID(),
              JSON.stringify({
                operationId: notificationOperationId,
                eventId: viewer.eventId,
                organisationId: viewer.organisationId,
                type: "decision.notification",
                idempotencyKey: `decision-notification:${decisionId}`,
                payload: { decisionId },
              }),
              decisionId,
              viewer.eventId,
            ),
          ]
        : []),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'submission_decision', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM submission_decisions WHERE id = ? AND event_id = ?)
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.release ? "decision.published" : "decision.drafted",
        decisionId,
        JSON.stringify({
          decision: parsed.decision,
          sessionId,
          notificationOperationId,
        }),
        decisionId,
        viewer.eventId,
      ),
    ];
    const [updated] = await this.env.DB.batch(statements);
    if ((updated.meta.changes ?? 0) !== 1) {
      if (sessionId) {
        const pendingSpeaker = await this.env.DB.prepare(
          `
          SELECT 1 FROM submission_speakers
           WHERE event_id = ? AND submission_id = ? AND person_id IS NULL
           LIMIT 1
        `,
        )
          .bind(viewer.eventId, submission.id)
          .first();
        if (pendingSpeaker) {
          throw new EvaluationStateError(
            "Claim every co-speaker before releasing an accepted decision. No speaker will be silently omitted from the session.",
          );
        }
      }
      if (parsed.release && viewer.role === "committee_chair") {
        const authority = await this.env.DB.prepare(
          `
          SELECT 1 FROM evaluation_plans
           WHERE event_id = ? AND status = 'active'
             AND decision_role = 'committee_chair'
           LIMIT 1
        `,
        )
          .bind(viewer.eventId)
          .first();
        if (!authority) throw new EvaluationDecisionAuthorityError();
      }
      throw new EvaluationRevisionConflictError(
        "This submission changed before the decision was saved. Refresh before trying again.",
      );
    }
    let notificationStatus: "not_requested" | "queued" | "queue_failed" =
      notificationOperationId ? "queued" : "not_requested";
    if (notificationOperationId) {
      const message = {
        operationId: notificationOperationId,
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        type: "decision.notification",
        idempotencyKey: `decision-notification:${decisionId}`,
        payload: { decisionId },
      };
      try {
        await this.env.OPERATIONS_QUEUE.send(message);
      } catch (error) {
        notificationStatus = "queue_failed";
        await this.env.DB.prepare(
          "UPDATE operation_jobs SET status = 'queue_failed', last_error = ?, updated_at = unixepoch() WHERE id = ?",
        )
          .bind(
            error instanceof Error ? error.message : String(error),
            notificationOperationId,
          )
          .run();
      }
    }
    return {
      decisionId,
      sessionId,
      notificationOperationId,
      notificationStatus,
    };
  }
}
