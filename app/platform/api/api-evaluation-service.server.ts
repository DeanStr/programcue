import { z } from "zod";
import { requireValue } from "~/lib/required-value";

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ApiError, type ApiPrincipal } from "./api.server";
import {
  decodePrivateCursor,
  encodePrivateCursor,
  isoTimestamp,
  parseStrictQuery,
} from "./api-pagination.server";

export const EVALUATION_API_RESOURCES = [
  "plans",
  "teams",
  "rounds",
  "round-reviewers",
  "assignments",
  "reviews",
  "conflicts",
  "moderations",
] as const;

export type EvaluationApiResource = (typeof EVALUATION_API_RESOURCES)[number];

const resourceSchema = z.enum(EVALUATION_API_RESOURCES);
const limitSchema = z
  .string()
  .regex(/^\d+$/u, "limit must be a whole number from 1 to 100")
  .transform(Number)
  .pipe(z.number().int().min(1).max(100))
  .default(50);
const baseQuery = {
  limit: limitSchema,
  cursor: z.string().trim().min(1).max(512).optional(),
};
const querySchemas = {
  plans: z
    .object({
      ...baseQuery,
      q: z.string().trim().min(1).max(160).optional(),
      status: z.enum(["draft", "active", "closed", "archived"]).optional(),
    })
    .strict(),
  teams: z
    .object({
      ...baseQuery,
      q: z.string().trim().min(1).max(160).optional(),
      status: z.enum(["active", "archived"]).optional(),
    })
    .strict(),
  rounds: z
    .object({
      ...baseQuery,
      q: z.string().trim().min(1).max(160).optional(),
      status: z.enum(["draft", "active", "closed", "archived"]).optional(),
      planId: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  "round-reviewers": z
    .object({
      ...baseQuery,
      q: z.string().trim().min(1).max(160).optional(),
      roundId: z.string().trim().min(1).max(200).optional(),
      evaluatorPersonId: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  assignments: z
    .object({
      ...baseQuery,
      status: z
        .enum([
          "assigned",
          "in_progress",
          "submitted",
          "recused",
          "reopened",
          "cancelled",
        ])
        .optional(),
      roundId: z.string().trim().min(1).max(200).optional(),
      targetType: z.enum(["submission", "session"]).optional(),
      targetId: z.string().trim().min(1).max(200).optional(),
      evaluatorPersonId: z.string().trim().min(1).max(200).optional(),
      teamId: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  reviews: z
    .object({
      ...baseQuery,
      status: z.enum(["draft", "submitted", "locked", "reopened"]).optional(),
      roundId: z.string().trim().min(1).max(200).optional(),
      targetType: z.enum(["submission", "session"]).optional(),
      targetId: z.string().trim().min(1).max(200).optional(),
      evaluatorPersonId: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  conflicts: z
    .object({
      ...baseQuery,
      status: z.enum(["declared", "recused", "waived", "dismissed"]).optional(),
      roundId: z.string().trim().min(1).max(200).optional(),
      targetType: z.enum(["submission", "session"]).optional(),
      targetId: z.string().trim().min(1).max(200).optional(),
      evaluatorPersonId: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  moderations: z
    .object({
      ...baseQuery,
      status: z.enum(["draft", "confirmed", "superseded"]).optional(),
      roundId: z.string().trim().min(1).max(200).optional(),
      submissionId: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
} satisfies Record<EvaluationApiResource, z.ZodType>;

type EvaluationQuery = {
  limit: number;
  cursor?: string;
  q?: string;
  status?: string;
  planId?: string;
  roundId?: string;
  submissionId?: string;
  targetType?: "submission" | "session";
  targetId?: string;
  evaluatorPersonId?: string;
  teamId?: string;
};

type EventPrincipal = ApiPrincipal & { eventId: string };
type PageRow = { id: string; sort: number } & Record<string, unknown>;

export function parseEvaluationResource(value: string | undefined) {
  const parsed = resourceSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      404,
      "API_RESOURCE_NOT_FOUND",
      "Evaluation API resource not found",
    );
  return parsed.data;
}

export function parseEvaluationQuery(
  request: Request,
  resource: EvaluationApiResource,
): EvaluationQuery {
  return parseStrictQuery(
    request,
    querySchemas[resource] as unknown as z.ZodType<EvaluationQuery>,
    `The evaluation ${resource} query parameters are invalid`,
  );
}

function escapeLike(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function filters(
  input: EvaluationQuery,
  columns: Partial<Record<keyof EvaluationQuery, string>>,
) {
  let sql = "";
  const bindings: unknown[] = [];
  for (const [key, column] of Object.entries(columns) as Array<
    [keyof EvaluationQuery, string]
  >) {
    const value = input[key];
    if (typeof value !== "string") continue;
    if (key === "q") {
      sql += ` AND ${column} LIKE ? ESCAPE '\\' COLLATE NOCASE`;
      bindings.push(`%${escapeLike(value)}%`);
    } else {
      sql += ` AND ${column} = ?`;
      bindings.push(value);
    }
  }
  if (input.cursor) {
    const cursor = decodePrivateCursor(input.cursor);
    sql += " AND (base.sort < ? OR (base.sort = ? AND base.id < ?))";
    bindings.push(cursor.sort, cursor.sort, cursor.id);
  }
  return { sql, bindings };
}

function parseJson(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new Error(`${label} is missing persisted JSON.`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} contains invalid persisted JSON.`);
  }
}

function parseCriterionOptions(
  value: unknown,
  label: string,
  inputType: string,
) {
  const parsed = parseJson(value, label);
  if (
    !Array.isArray(parsed) ||
    parsed.some((option) => typeof option !== "string" || !option.trim())
  ) {
    throw new Error(`${label} has an invalid persisted option list.`);
  }
  if (inputType === "dropdown" && parsed.length === 0) {
    throw new Error(`${label} cannot be empty for a dropdown criterion.`);
  }
  if (inputType !== "dropdown" && parsed.length > 0) {
    throw new Error(`${label} is present on a non-dropdown criterion.`);
  }
  return parsed;
}

const responseKeys: Record<EvaluationApiResource, string> = {
  plans: "plans",
  teams: "teams",
  rounds: "rounds",
  "round-reviewers": "roundReviewers",
  assignments: "assignments",
  reviews: "reviews",
  conflicts: "conflicts",
  moderations: "moderations",
};

export class ApiEvaluationService {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  async list(
    principal: EventPrincipal,
    resource: EvaluationApiResource,
    input: EvaluationQuery,
  ) {
    await this.airtable.assertReadable(principal);
    const rows = await this.query(principal, resource, input);
    const visible = rows.slice(0, input.limit);
    const records = visible.map(({ sort: _sort, ...row }) =>
      this.serialise(resource, row),
    );
    if (resource === "rounds" && records.length) {
      const ids = records.map((record) => String(record.id));
      const criteria = await this.env.DB.prepare(
        `SELECT criterion.id, criterion.round_id AS roundId, criterion.name,
                criterion.description, criterion.input_type AS inputType,
                criterion.options_json AS optionsJson,
                criterion.weight_percent AS weightPercent,
                criterion.required, criterion.position
           FROM evaluation_criteria criterion
           JOIN evaluation_rounds round ON round.id = criterion.round_id
             AND round.event_id = criterion.event_id
           JOIN events event ON event.id = round.event_id
             AND event.organisation_id = ?
          WHERE criterion.event_id = ?
            AND criterion.round_id IN (
              SELECT CAST(value AS TEXT) FROM json_each(?)
            )
          ORDER BY criterion.round_id, criterion.position, criterion.id`,
      )
        .bind(principal.organisationId, principal.eventId, JSON.stringify(ids))
        .all<Record<string, unknown> & { roundId: string; required: number }>();
      for (const record of records) {
        record.criteria = criteria.results
          .filter((criterion) => criterion.roundId === record.id)
          .map(({ optionsJson, ...criterion }) => ({
            ...criterion,
            options: parseCriterionOptions(
              optionsJson,
              `Evaluation criterion ${String(criterion.id)} options`,
              String(criterion.inputType),
            ),
            required: Boolean(criterion.required),
          }));
      }
    }
    return {
      [responseKeys[resource]]: records,
      nextCursor:
        rows.length > input.limit && visible.length
          ? encodePrivateCursor(
              requireValue(
                visible.at(-1),
                "Required visible.at(-1) is unavailable.",
              ).sort,
              String(
                requireValue(
                  visible.at(-1),
                  "Required visible.at(-1) is unavailable.",
                ).id,
              ),
            )
          : null,
    };
  }

  private async query(
    principal: EventPrincipal,
    resource: EvaluationApiResource,
    input: EvaluationQuery,
  ): Promise<PageRow[]> {
    let sql: string;
    let selectedFilters: ReturnType<typeof filters>;
    if (resource === "plans") {
      selectedFilters = filters(input, {
        q: "base.name",
        status: "base.status",
      });
      sql = `SELECT * FROM (
        SELECT plan.id, plan.created_at AS sort, plan.name, plan.status,
               CASE WHEN EXISTS (
                 SELECT 1 FROM evaluation_rounds round
                  WHERE round.plan_id = plan.id
                    AND round.event_id = plan.event_id
                    AND round.blinded_reviewing = 1
               ) THEN 1 ELSE 0 END AS blindedReviewing,
               plan.decision_role AS decisionRole, plan.revision,
               plan.created_by_person_id AS createdByPersonId,
               plan.created_at AS createdAt, plan.updated_at AS updatedAt,
               (SELECT COUNT(*) FROM evaluation_rounds round
                 WHERE round.plan_id = plan.id AND round.event_id = plan.event_id)
                 AS roundCount
          FROM evaluation_plans plan
          JOIN events event ON event.id = plan.event_id
            AND event.organisation_id = ?
         WHERE plan.event_id = ?
      ) base WHERE 1 = 1${selectedFilters.sql}
      ORDER BY base.sort DESC, base.id DESC LIMIT ?`;
    } else if (resource === "teams") {
      selectedFilters = filters(input, {
        q: "base.name",
        status: "base.status",
      });
      sql = `SELECT * FROM (
        SELECT team.id, team.created_at AS sort, team.name, team.description,
               team.chair_person_id AS chairPersonId,
               chair.display_name AS chairName, team.status,
               team.created_at AS createdAt, team.updated_at AS updatedAt,
               (SELECT COUNT(*) FROM evaluation_team_members member
                 WHERE member.team_id = team.id AND member.event_id = team.event_id
                   AND member.removed_at IS NULL) AS activeMemberCount
          FROM evaluation_teams team
          JOIN events event ON event.id = team.event_id
            AND event.organisation_id = ?
          LEFT JOIN people chair ON chair.id = team.chair_person_id
         WHERE team.event_id = ?
      ) base WHERE 1 = 1${selectedFilters.sql}
      ORDER BY base.sort DESC, base.id DESC LIMIT ?`;
    } else if (resource === "rounds") {
      selectedFilters = filters(input, {
        q: "base.name",
        status: "base.status",
        planId: "base.planId",
      });
      sql = `SELECT * FROM (
        SELECT round.id, round.created_at AS sort, round.plan_id AS planId,
               round.round_number AS roundNumber, round.name, round.status,
               round.opens_at AS opensAt, round.closes_at AS closesAt,
               round.blinded_reviewing AS blindedReviewing,
               round.scorecard_id AS scorecardId,
               round.scorecard_version AS scorecardVersion,
               round.advancement_rule_json AS advancementRuleJson,
               round.revision, round.created_at AS createdAt,
               round.updated_at AS updatedAt
          FROM evaluation_rounds round
          JOIN events event ON event.id = round.event_id
            AND event.organisation_id = ?
         WHERE round.event_id = ?
      ) base WHERE 1 = 1${selectedFilters.sql}
      ORDER BY base.sort DESC, base.id DESC LIMIT ?`;
    } else if (resource === "round-reviewers") {
      selectedFilters = filters(input, {
        q: "base.personName",
        roundId: "base.roundId",
        evaluatorPersonId: "base.personId",
      });
      sql = `SELECT * FROM (
        SELECT pool.id, pool.created_at AS sort,
               pool.round_id AS roundId, round.name AS roundName,
               pool.person_id AS personId, person.display_name AS personName,
               person.email AS personEmail,
               pool.added_by_person_id AS addedByPersonId,
               pool.revision, pool.created_at AS createdAt,
               pool.updated_at AS updatedAt
          FROM evaluation_round_reviewers pool
          JOIN events event ON event.id = pool.event_id
            AND event.organisation_id = ?
          JOIN evaluation_rounds round ON round.id = pool.round_id
            AND round.event_id = pool.event_id
          JOIN people person ON person.id = pool.person_id
         WHERE pool.event_id = ?
      ) base WHERE 1 = 1${selectedFilters.sql}
      ORDER BY base.sort DESC, base.id DESC LIMIT ?`;
    } else if (resource === "assignments") {
      selectedFilters = filters(input, {
        status: "base.status",
        roundId: "base.roundId",
        targetType: "base.targetType",
        targetId: "base.targetId",
        evaluatorPersonId: "base.evaluatorPersonId",
        teamId: "base.teamId",
      });
      sql = `SELECT * FROM (
        SELECT assignment.id, assignment.assigned_at AS sort,
               assignment.round_id AS roundId,
               round.name AS roundName,
               CASE WHEN assignment.submission_id IS NOT NULL
                    THEN 'submission' ELSE 'session' END AS targetType,
               COALESCE(assignment.submission_id, assignment.session_id) AS targetId,
               CASE WHEN assignment.submission_id IS NOT NULL
                    THEN submission.title
                    ELSE json_extract(assignment.session_snapshot_json, '$.title')
               END AS targetTitle,
               assignment.evaluator_person_id AS evaluatorPersonId,
               evaluator.display_name AS evaluatorName,
               assignment.team_id AS teamId, team.name AS teamName,
               assignment.status, assignment.revision,
               assignment.due_at AS dueAt,
               assignment.conflict_declared_at AS conflictDeclaredAt,
               assignment.assigned_at AS assignedAt,
               assignment.submitted_at AS submittedAt
          FROM evaluator_assignments assignment
          JOIN events event ON event.id = assignment.event_id
            AND event.organisation_id = ?
          JOIN evaluation_rounds round ON round.id = assignment.round_id
            AND round.event_id = assignment.event_id
          LEFT JOIN submissions submission ON submission.id = assignment.submission_id
            AND submission.event_id = assignment.event_id
          JOIN people evaluator ON evaluator.id = assignment.evaluator_person_id
          LEFT JOIN evaluation_teams team ON team.id = assignment.team_id
            AND team.event_id = assignment.event_id
         WHERE assignment.event_id = ?
      ) base WHERE 1 = 1${selectedFilters.sql}
      ORDER BY base.sort DESC, base.id DESC LIMIT ?`;
    } else if (resource === "reviews") {
      selectedFilters = filters(input, {
        status: "base.status",
        roundId: "base.roundId",
        targetType: "base.targetType",
        targetId: "base.targetId",
        evaluatorPersonId: "base.evaluatorPersonId",
      });
      sql = `SELECT * FROM (
        SELECT review.id, review.created_at AS sort,
               review.assignment_id AS assignmentId,
               assignment.round_id AS roundId,
               CASE WHEN assignment.submission_id IS NOT NULL
                    THEN 'submission' ELSE 'session' END AS targetType,
               COALESCE(assignment.submission_id, assignment.session_id) AS targetId,
               CASE WHEN assignment.submission_id IS NOT NULL
                    THEN submission.title
                    ELSE json_extract(assignment.session_snapshot_json, '$.title')
               END AS targetTitle,
               assignment.evaluator_person_id AS evaluatorPersonId,
               evaluator.display_name AS evaluatorName,
               review.status, review.scores_json AS scoresJson,
               review.weighted_score AS weightedScore,
               review.recommendation, review.confidence,
               review.submitter_feedback AS submitterFeedback,
               review.private_notes AS privateNotes, review.revision,
               review.created_at AS createdAt, review.updated_at AS updatedAt,
               review.submitted_at AS submittedAt, review.locked_at AS lockedAt
          FROM reviews review
          JOIN events event ON event.id = review.event_id
            AND event.organisation_id = ?
          JOIN evaluator_assignments assignment ON assignment.id = review.assignment_id
            AND assignment.event_id = review.event_id
          LEFT JOIN submissions submission ON submission.id = assignment.submission_id
            AND submission.event_id = assignment.event_id
          JOIN people evaluator ON evaluator.id = assignment.evaluator_person_id
         WHERE review.event_id = ?
      ) base WHERE 1 = 1${selectedFilters.sql}
      ORDER BY base.sort DESC, base.id DESC LIMIT ?`;
    } else if (resource === "conflicts") {
      selectedFilters = filters(input, {
        status: "base.status",
        roundId: "base.roundId",
        targetType: "base.targetType",
        targetId: "base.targetId",
        evaluatorPersonId: "base.evaluatorPersonId",
      });
      sql = `SELECT * FROM (
        SELECT conflict.id, conflict.declared_at AS sort,
               conflict.round_id AS roundId,
               CASE WHEN conflict.submission_id IS NOT NULL
                    THEN 'submission' ELSE 'session' END AS targetType,
               COALESCE(conflict.submission_id, conflict.session_id) AS targetId,
               COALESCE(submission.title, session.title) AS targetTitle,
               conflict.evaluator_person_id AS evaluatorPersonId,
               evaluator.display_name AS evaluatorName,
               conflict.relationship, conflict.notes, conflict.status,
               conflict.declared_at AS declaredAt,
               conflict.resolved_by_person_id AS resolvedByPersonId,
               conflict.resolved_at AS resolvedAt
          FROM evaluator_conflicts conflict
          JOIN events event ON event.id = conflict.event_id
            AND event.organisation_id = ?
          LEFT JOIN submissions submission ON submission.id = conflict.submission_id
            AND submission.event_id = conflict.event_id
          LEFT JOIN sessions session ON session.id = conflict.session_id
            AND session.event_id = conflict.event_id
          JOIN people evaluator ON evaluator.id = conflict.evaluator_person_id
         WHERE conflict.event_id = ?
      ) base WHERE 1 = 1${selectedFilters.sql}
      ORDER BY base.sort DESC, base.id DESC LIMIT ?`;
    } else {
      selectedFilters = filters(input, {
        status: "base.status",
        roundId: "base.roundId",
        submissionId: "base.submissionId",
      });
      sql = `SELECT * FROM (
        SELECT moderation.id, moderation.created_at AS sort,
               moderation.round_id AS roundId,
               moderation.submission_id AS submissionId,
               submission.title AS submissionTitle,
               moderation.moderator_person_id AS moderatorPersonId,
               moderator.display_name AS moderatorName,
               moderation.status, moderation.recommendation,
               moderation.moderated_score AS moderatedScore,
               moderation.notes, moderation.created_at AS createdAt,
               moderation.updated_at AS updatedAt,
               moderation.confirmed_at AS confirmedAt
          FROM review_moderations moderation
          JOIN events event ON event.id = moderation.event_id
            AND event.organisation_id = ?
          JOIN submissions submission ON submission.id = moderation.submission_id
            AND submission.event_id = moderation.event_id
          JOIN people moderator ON moderator.id = moderation.moderator_person_id
         WHERE moderation.event_id = ?
      ) base WHERE 1 = 1${selectedFilters.sql}
      ORDER BY base.sort DESC, base.id DESC LIMIT ?`;
    }
    return (
      await this.env.DB.prepare(sql)
        .bind(
          principal.organisationId,
          principal.eventId,
          ...selectedFilters.bindings,
          input.limit + 1,
        )
        .all<PageRow>()
    ).results;
  }

  private serialise(
    resource: EvaluationApiResource,
    row: Record<string, unknown>,
  ) {
    const result = { ...row };
    for (const field of [
      "opensAt",
      "closesAt",
      "dueAt",
      "conflictDeclaredAt",
      "assignedAt",
      "submittedAt",
      "lockedAt",
      "declaredAt",
      "resolvedAt",
      "confirmedAt",
      "createdAt",
      "updatedAt",
    ]) {
      if (field in result)
        result[field] = isoTimestamp(result[field] as number | null);
    }
    if (resource === "plans")
      result.blindedReviewing = Boolean(result.blindedReviewing);
    if (resource === "rounds") {
      result.blindedReviewing = Boolean(result.blindedReviewing);
      result.advancementRule = parseJson(
        result.advancementRuleJson,
        `Evaluation round ${String(result.id)} advancement rule`,
      );
      delete result.advancementRuleJson;
    }
    if (resource === "reviews") {
      result.scores = parseJson(
        result.scoresJson,
        `Review ${String(result.id)} scores`,
      );
      delete result.scoresJson;
    }
    return result;
  }
}
