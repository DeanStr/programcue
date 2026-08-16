import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import { EvaluationServiceFoundation } from "./evaluation-service-foundation.server";

const MAX_EXPORT_ASSIGNMENTS = 25_000;
const MAX_EXPORT_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_ENCODED_BYTES = 8 * 1024 * 1024;
const roundIdSchema = z.string().trim().min(1).max(128);
const exportIntentSchema = z.uuid();

const persistedScoreValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);
const persistedScoresSchema = z.record(z.string(), persistedScoreValueSchema);

type AssignmentRow = {
  roundId: string;
  roundNumber: number;
  roundName: string;
  roundStatus: string;
  submissionId: string;
  submissionReference: string;
  submissionTitle: string;
  submissionStatus: string;
  assignmentId: string | null;
  assignmentStatus:
    | "assigned"
    | "in_progress"
    | "submitted"
    | "recused"
    | "reopened"
    | "cancelled"
    | null;
  reviewStatus: "draft" | "submitted" | "locked" | "reopened" | null;
  scoresJson: string | null;
  weightedScore: number | null;
  recommendation:
    | "accept"
    | "minor_changes"
    | "conditional_accept"
    | "waitlist"
    | "reject"
    | null;
};

type CriterionRow = {
  id: string;
  roundId: string;
  name: string;
  inputType: "scale_5" | "scale_10" | "yes_no" | "free_text" | "dropdown";
  optionsJson: string;
  required: number | boolean;
  position: number;
};

type ExportPreflight = {
  roundExists: number;
  assignmentCount: number;
  criterionCount: number;
  sourceBytes: number;
};

const exportSourceSnapshotCtes = `
  current_plan AS (
    SELECT plan.id
      FROM evaluation_plans plan
      JOIN events event
        ON event.id = plan.event_id AND event.organisation_id = ?
     WHERE plan.event_id = ? AND plan.status <> 'archived'
     ORDER BY plan.created_at DESC, plan.id DESC
     LIMIT 1
  ), selected_round AS (
    SELECT round.id, round.event_id, round.round_number,
           round.name, round.status
      FROM current_plan plan
      JOIN evaluation_rounds round
        ON round.plan_id = plan.id AND round.event_id = ?
     WHERE round.id = ? AND round.status <> 'archived'
  ), assignment_source AS (
    SELECT round.id AS roundId, round.round_number AS roundNumber,
           round.name AS roundName, round.status AS roundStatus,
           submission.id AS submissionId,
           submission.public_reference AS submissionReference,
           submission.title AS submissionTitle,
           submission.status AS submissionStatus,
           assignment.id AS assignmentId,
           assignment.status AS assignmentStatus,
           review.status AS reviewStatus,
           review.scores_json AS scoresJson,
           review.weighted_score AS weightedScore,
           review.recommendation,
           length(CAST(round.id AS BLOB))
             + length(CAST(round.name AS BLOB))
             + length(CAST(round.status AS BLOB))
             + length(CAST(submission.id AS BLOB))
             + length(CAST(submission.public_reference AS BLOB))
             + length(CAST(submission.title AS BLOB))
             + length(CAST(submission.status AS BLOB))
             + length(CAST(COALESCE(assignment.id, '') AS BLOB))
             + length(CAST(COALESCE(assignment.status, '') AS BLOB))
             + length(CAST(COALESCE(review.status, '') AS BLOB))
             + length(CAST(COALESCE(review.scores_json, '') AS BLOB))
             + length(CAST(COALESCE(review.recommendation, '') AS BLOB))
             AS sourceBytes
      FROM selected_round round
      JOIN submissions submission
        ON submission.event_id = round.event_id
       AND submission.status <> 'draft'
      LEFT JOIN evaluator_assignments assignment
        ON assignment.round_id = round.id
       AND assignment.event_id = round.event_id
       AND assignment.submission_id = submission.id
      LEFT JOIN reviews review
        ON review.assignment_id = assignment.id
       AND review.event_id = assignment.event_id
  ), criterion_source AS (
    SELECT criterion.id, criterion.round_id AS roundId,
           criterion.name, criterion.input_type AS inputType,
           criterion.options_json AS optionsJson,
           criterion.required, criterion.position,
           length(CAST(criterion.id AS BLOB))
             + length(CAST(criterion.round_id AS BLOB))
             + length(CAST(criterion.name AS BLOB))
             + length(CAST(criterion.input_type AS BLOB))
             + length(CAST(criterion.options_json AS BLOB))
             AS sourceBytes
      FROM selected_round round
      JOIN evaluation_criteria criterion
        ON criterion.round_id = round.id
       AND criterion.event_id = round.event_id
  ), source_stats AS (
    SELECT CASE WHEN EXISTS (SELECT 1 FROM selected_round) THEN 1 ELSE 0 END
             AS roundExists,
           (SELECT COUNT(*) FROM assignment_source) AS assignmentCount,
           (SELECT COUNT(*) FROM criterion_source) AS criterionCount,
           COALESCE((SELECT SUM(sourceBytes) FROM assignment_source), 0)
             + COALESCE((SELECT SUM(sourceBytes) FROM criterion_source), 0)
             AS sourceBytes
  )`;

type CsvValue = string | number | null;

export class EvaluationResultsExportTooLargeError extends Error {
  constructor(limit: "assignments" | "source" | "encoded") {
    const message =
      limit === "assignments"
        ? `The Abstract results export exceeds ${MAX_EXPORT_ASSIGNMENTS.toLocaleString()} assignments.`
        : limit === "source"
          ? "The Abstract results export source data exceeds the safe 8 MiB limit."
          : "The generated Abstract results CSV exceeds the safe 8 MiB limit.";
    super(`${message} Narrow the current evaluation plan before exporting.`);
    this.name = "EvaluationResultsExportTooLargeError";
  }
}

export class EvaluationResultsExportRoundNotFoundError extends Error {
  constructor() {
    super(
      "The selected evaluation round is not in the current evaluation plan.",
    );
    this.name = "EvaluationResultsExportRoundNotFoundError";
  }
}

export class EvaluationResultsExportIdempotencyConflictError extends Error {
  constructor() {
    super(
      "That Abstract results export intent already captured a different round or data snapshot. Start a new export.",
    );
    this.name = "EvaluationResultsExportIdempotencyConflictError";
  }
}

async function exportSnapshotHash(csvBytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", csvBytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function spreadsheetSafe(value: CsvValue) {
  const text = value === null ? "" : String(value);
  return /^[\u0000-\u0020]*[=+\-@]/u.test(text) ? `'${text}` : text;
}

function csvCell(value: CsvValue) {
  const text = spreadsheetSafe(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function renderCsvLine(
  columns: readonly string[],
  row?: Readonly<Record<string, CsvValue>>,
) {
  const values = row ? columns.map((column) => row[column] ?? null) : columns;
  return `${values.map(csvCell).join(",")}\r\n`;
}

function groupKey(roundId: string, submissionId: string) {
  return `${roundId}\u0000${submissionId}`;
}

function assertScoreValue(criterion: CriterionRow, value: unknown) {
  if (criterion.inputType === "scale_5" || criterion.inputType === "scale_10") {
    const maximum = criterion.inputType === "scale_10" ? 10 : 5;
    if (
      !Number.isInteger(value) ||
      Number(value) < 1 ||
      Number(value) > maximum
    ) {
      throw new Error(
        `Review result for criterion ${criterion.id} is not a whole-number score from 1 to ${maximum}.`,
      );
    }
    return value as number;
  }
  if (criterion.inputType === "yes_no") {
    if (typeof value !== "boolean") {
      throw new Error(
        `Review result for criterion ${criterion.id} is not a yes/no value.`,
      );
    }
    return value;
  }
  if (criterion.inputType === "dropdown") {
    let options: unknown;
    try {
      options = JSON.parse(criterion.optionsJson);
    } catch {
      throw new Error(
        `Evaluation criterion ${criterion.id} has invalid persisted dropdown options.`,
      );
    }
    if (
      !Array.isArray(options) ||
      options.length === 0 ||
      options.some((option) => typeof option !== "string" || !option.trim())
    ) {
      throw new Error(
        `Evaluation criterion ${criterion.id} has invalid persisted dropdown options.`,
      );
    }
    if (typeof value !== "string" || !options.includes(value)) {
      throw new Error(
        `Review result for criterion ${criterion.id} is not one of its persisted dropdown options.`,
      );
    }
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `Review result for criterion ${criterion.id} is not a non-empty text value.`,
    );
  }
  return value.trim();
}

function criterionResult(
  criterion: CriterionRow,
  values: ReadonlyArray<string | number | boolean>,
) {
  const base = {
    criterion: criterion.name,
    inputType: criterion.inputType,
    responseCount: values.length,
  };
  if (criterion.inputType === "scale_5" || criterion.inputType === "scale_10") {
    const numericValues = values as number[];
    return {
      ...base,
      averageScore:
        numericValues.length === 0
          ? null
          : Number(
              (
                numericValues.reduce((sum, value) => sum + value, 0) /
                numericValues.length
              ).toFixed(2),
            ),
    };
  }
  if (criterion.inputType === "free_text") {
    return { ...base, responses: values };
  }
  const responseCounts = new Map<string, number>();
  for (const value of values) {
    const label =
      typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
    responseCounts.set(label, (responseCounts.get(label) ?? 0) + 1);
  }
  return {
    ...base,
    responseCounts: Object.fromEntries(
      [...responseCounts.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

const columns = [
  "roundId",
  "roundNumber",
  "roundName",
  "roundStatus",
  "submissionId",
  "submissionReference",
  "submissionTitle",
  "submissionStatus",
  "reviewStatus",
  "assignedReviews",
  "completedReviews",
  "outstandingReviews",
  "recusedReviews",
  "cancelledReviews",
  "aggregateWeightedScore",
  "recommendation",
  "recommendationBreakdown",
  "criterionResults",
] as const;

export class EvaluationResultsExportService extends EvaluationServiceFoundation {
  private async existingExport(viewer: Viewer, idempotencyKey: string) {
    const existing = await this.env.DB.prepare(
      `SELECT id, payload_json AS payloadJson, result_json AS resultJson
         FROM operation_jobs
        WHERE event_id = ? AND organisation_id = ?
          AND requested_by_person_id = ?
          AND type = 'evaluation.results.export' AND idempotency_key = ?
        LIMIT 1`,
    )
      .bind(
        viewer.eventId,
        viewer.organisationId,
        viewer.personId,
        idempotencyKey,
      )
      .first<{ id: string; payloadJson: string; resultJson: string }>();
    if (!existing) return null;
    const payload = z
      .object({
        type: z.literal("evaluation.results.export"),
        operationId: z.string().min(1),
        roundId: roundIdSchema,
      })
      .strict()
      .parse(JSON.parse(existing.payloadJson));
    if (payload.operationId !== existing.id) {
      throw new Error(
        "The durable Abstract results export identity is invalid.",
      );
    }
    const result = z
      .object({
        roundId: roundIdSchema,
        rowCount: z.number().int().nonnegative(),
        contentType: z.literal("text/csv"),
        csvSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .parse(JSON.parse(existing.resultJson));
    if (result.roundId !== payload.roundId) {
      throw new Error(
        "The durable Abstract results export round identity is invalid.",
      );
    }
    return {
      operationId: existing.id,
      roundId: result.roundId,
      rowCount: result.rowCount,
      csvSha256: result.csvSha256,
    };
  }

  async create(viewer: Viewer, rawRoundId: string, rawIntentKey: string) {
    return this.readAuthoritative(viewer, async () => {
      await this.assertViewerEvent(viewer);
      this.assertEvaluationManager(viewer);

      const roundId = roundIdSchema.parse(rawRoundId);
      const intentKey = exportIntentSchema.parse(rawIntentKey);
      const idempotencyKey = `evaluation-results-export:${viewer.personId}:${intentKey}`;
      const existing = await this.existingExport(viewer, idempotencyKey);
      if (existing && existing.roundId !== roundId) {
        throw new EvaluationResultsExportIdempotencyConflictError();
      }
      const snapshotScope = [
        viewer.organisationId,
        viewer.eventId,
        viewer.eventId,
        roundId,
      ] as const;
      const [preflightResult, assignmentResult, criterionRowsResult] =
        await this.env.DB.batch<ExportPreflight | AssignmentRow | CriterionRow>(
          [
            this.env.DB.prepare(
              `WITH ${exportSourceSnapshotCtes}
             SELECT roundExists, assignmentCount, criterionCount, sourceBytes
               FROM source_stats`,
            ).bind(...snapshotScope),
            this.env.DB.prepare(
              `WITH ${exportSourceSnapshotCtes}
             SELECT source.roundId, source.roundNumber, source.roundName,
                    source.roundStatus, source.submissionId,
                    source.submissionReference, source.submissionTitle,
                    source.submissionStatus, source.assignmentId,
                    source.assignmentStatus, source.reviewStatus,
                    source.scoresJson, source.weightedScore,
                    source.recommendation
               FROM assignment_source source
               CROSS JOIN source_stats stats
              WHERE stats.assignmentCount <= ? AND stats.sourceBytes <= ?
              ORDER BY source.roundNumber, source.roundId,
                       source.submissionReference, source.submissionId,
                       source.assignmentId`,
            ).bind(
              ...snapshotScope,
              MAX_EXPORT_ASSIGNMENTS,
              MAX_EXPORT_SOURCE_BYTES,
            ),
            this.env.DB.prepare(
              `WITH ${exportSourceSnapshotCtes}
             SELECT source.id, source.roundId, source.name, source.inputType,
                    source.optionsJson, source.required, source.position
               FROM criterion_source source
               CROSS JOIN source_stats stats
              WHERE stats.assignmentCount <= ? AND stats.sourceBytes <= ?
              ORDER BY source.position`,
            ).bind(
              ...snapshotScope,
              MAX_EXPORT_ASSIGNMENTS,
              MAX_EXPORT_SOURCE_BYTES,
            ),
          ],
        );
      const exportPreflight = preflightResult.results[0] as
        | ExportPreflight
        | undefined;
      if (!exportPreflight) {
        throw new Error(
          "The Abstract results export size could not be verified.",
        );
      }
      if (exportPreflight.roundExists !== 1) {
        throw new EvaluationResultsExportRoundNotFoundError();
      }
      if (
        exportPreflight.assignmentCount > MAX_EXPORT_ASSIGNMENTS ||
        exportPreflight.sourceBytes > MAX_EXPORT_SOURCE_BYTES
      ) {
        throw new EvaluationResultsExportTooLargeError(
          exportPreflight.assignmentCount > MAX_EXPORT_ASSIGNMENTS
            ? "assignments"
            : "source",
        );
      }
      const assignmentRows = assignmentResult.results as AssignmentRow[];
      const criterionRows = criterionRowsResult.results as CriterionRow[];
      if (
        assignmentRows.length !== exportPreflight.assignmentCount ||
        criterionRows.length !== exportPreflight.criterionCount
      ) {
        throw new Error(
          "The Abstract results export snapshot did not match its verified source counts.",
        );
      }
      if (assignmentRows.length > MAX_EXPORT_ASSIGNMENTS) {
        throw new EvaluationResultsExportTooLargeError("assignments");
      }
      if (criterionRows.length === 0) {
        throw new Error(
          `Evaluation round ${roundId} is missing its persisted scorecard rubric.`,
        );
      }

      const criteriaByRound = new Map<string, CriterionRow[]>();
      for (const criterion of criterionRows) {
        const criteria = criteriaByRound.get(criterion.roundId) ?? [];
        criteria.push(criterion);
        criteriaByRound.set(criterion.roundId, criteria);
      }

      const grouped = new Map<string, AssignmentRow[]>();
      for (const assignment of assignmentRows) {
        const key = groupKey(assignment.roundId, assignment.submissionId);
        const assignments = grouped.get(key) ?? [];
        assignments.push(assignment);
        grouped.set(key, assignments);
      }

      const encoder = new TextEncoder();
      const csvChunks: Uint8Array<ArrayBuffer>[] = [];
      let encodedByteLength = 0;
      let rowCount = 0;
      const appendCsvLine = (line: string) => {
        const chunk = encoder.encode(line);
        if (encodedByteLength + chunk.byteLength > MAX_EXPORT_ENCODED_BYTES) {
          throw new EvaluationResultsExportTooLargeError("encoded");
        }
        csvChunks.push(chunk);
        encodedByteLength += chunk.byteLength;
      };
      appendCsvLine(renderCsvLine(columns));

      for (const assignments of grouped.values()) {
        const first = assignments[0]!;
        const criteria = criteriaByRound.get(first.roundId);
        if (!criteria?.length) {
          throw new Error(
            `Evaluation round ${first.roundId} is missing its persisted scorecard rubric.`,
          );
        }
        const criteriaById = new Map(
          criteria.map((criterion) => [criterion.id, criterion]),
        );
        const responsesByCriterion = new Map<
          string,
          Array<string | number | boolean>
        >();
        const weightedScores: number[] = [];
        const recommendations = new Map<string, number>();
        let completedReviews = 0;
        let outstandingReviews = 0;
        let recusedReviews = 0;
        let cancelledReviews = 0;
        let assignedReviews = 0;

        for (const assignment of assignments) {
          if (assignment.assignmentId === null) {
            if (
              assignment.assignmentStatus !== null ||
              assignment.reviewStatus !== null ||
              assignment.scoresJson !== null ||
              assignment.weightedScore !== null ||
              assignment.recommendation !== null
            ) {
              throw new Error(
                `Unassigned submission ${assignment.submissionId} has inconsistent review result state.`,
              );
            }
            continue;
          }
          assignedReviews += 1;
          if (assignment.assignmentStatus === "recused") {
            recusedReviews += 1;
            continue;
          }
          if (assignment.assignmentStatus === "cancelled") {
            cancelledReviews += 1;
            continue;
          }
          if (assignment.assignmentStatus !== "submitted") {
            outstandingReviews += 1;
            continue;
          }
          if (
            assignment.reviewStatus !== "submitted" &&
            assignment.reviewStatus !== "locked"
          ) {
            throw new Error(
              `Submitted evaluation assignment ${assignment.assignmentId} is missing its submitted review.`,
            );
          }
          if (assignment.weightedScore === null) {
            throw new Error(
              `Submitted review for assignment ${assignment.assignmentId} is missing its weighted score.`,
            );
          }
          if (assignment.scoresJson === null) {
            throw new Error(
              `Submitted review for assignment ${assignment.assignmentId} is missing its scorecard responses.`,
            );
          }
          const parsedScores = persistedScoresSchema.parse(
            JSON.parse(assignment.scoresJson),
          );
          for (const criterionId of Object.keys(parsedScores)) {
            if (!criteriaById.has(criterionId)) {
              throw new Error(
                `Submitted review for assignment ${assignment.assignmentId} references unknown criterion ${criterionId}.`,
              );
            }
          }
          for (const criterion of criteria) {
            const rawValue = parsedScores[criterion.id];
            if (rawValue === undefined) {
              if (Boolean(criterion.required)) {
                throw new Error(
                  `Submitted review for assignment ${assignment.assignmentId} is missing required criterion ${criterion.id}.`,
                );
              }
              continue;
            }
            const value = assertScoreValue(criterion, rawValue);
            const responses = responsesByCriterion.get(criterion.id) ?? [];
            responses.push(value);
            responsesByCriterion.set(criterion.id, responses);
          }
          completedReviews += 1;
          weightedScores.push(assignment.weightedScore);
          if (assignment.recommendation) {
            recommendations.set(
              assignment.recommendation,
              (recommendations.get(assignment.recommendation) ?? 0) + 1,
            );
          }
        }

        const reviewableReviews = completedReviews + outstandingReviews;
        const reviewStatus =
          assignedReviews === 0
            ? "not_assigned"
            : reviewableReviews === 0
              ? recusedReviews > 0
                ? "recused"
                : "not_started"
              : completedReviews === reviewableReviews
                ? "complete"
                : completedReviews > 0
                  ? "partial"
                  : "not_started";
        const recommendationEntries = [...recommendations.entries()].sort(
          ([left], [right]) => left.localeCompare(right),
        );
        const recommendation =
          recommendationEntries.length === 0
            ? ""
            : recommendationEntries.length === 1
              ? recommendationEntries[0]![0]
              : "mixed";
        const aggregateWeightedScore =
          weightedScores.length === 0
            ? null
            : Number(
                (
                  weightedScores.reduce((sum, score) => sum + score, 0) /
                  weightedScores.length
                ).toFixed(2),
              );

        const row = {
          roundId: first.roundId,
          roundNumber: first.roundNumber,
          roundName: first.roundName,
          roundStatus: first.roundStatus,
          submissionId: first.submissionId,
          submissionReference: first.submissionReference,
          submissionTitle: first.submissionTitle,
          submissionStatus: first.submissionStatus,
          reviewStatus,
          assignedReviews,
          completedReviews,
          outstandingReviews,
          recusedReviews,
          cancelledReviews,
          aggregateWeightedScore,
          recommendation,
          recommendationBreakdown: JSON.stringify(
            Object.fromEntries(recommendationEntries),
          ),
          criterionResults: JSON.stringify(
            criteria.map((criterion) =>
              criterionResult(
                criterion,
                responsesByCriterion.get(criterion.id) ?? [],
              ),
            ),
          ),
        } satisfies Record<(typeof columns)[number], CsvValue>;
        appendCsvLine(renderCsvLine(columns, row));
        rowCount += 1;
      }

      const csvBytes = new Uint8Array(encodedByteLength);
      let writeOffset = 0;
      for (const chunk of csvChunks) {
        csvBytes.set(chunk, writeOffset);
        writeOffset += chunk.byteLength;
      }
      const csvSha256 = await exportSnapshotHash(csvBytes);
      if (existing) {
        if (
          existing.rowCount !== rowCount ||
          existing.csvSha256 !== csvSha256
        ) {
          throw new EvaluationResultsExportIdempotencyConflictError();
        }
        return {
          body: csvBytes,
          filename: "program-cue-abstract-review-results.csv",
          rowCount,
          operationId: existing.operationId,
        };
      }

      const operationId = crypto.randomUUID();
      const correlationId = crypto.randomUUID();
      const resultJson = JSON.stringify({
        roundId,
        rowCount,
        contentType: "text/csv",
        csvSha256,
      });
      const [created] = await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO operation_jobs (
             id, organisation_id, event_id, requested_by_person_id, type,
             idempotency_key, correlation_id, status, payload_json,
             result_json, progress_total, progress_completed, progress_failed,
             cancellable, started_at, completed_at, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, 'evaluation.results.export', ?, ?, 'completed',
                  ?, ?, ?, ?, 0, 0, unixepoch(), unixepoch(), unixepoch(),
                  unixepoch()
             FROM events event
            WHERE event.id = ? AND event.organisation_id = ?`,
        ).bind(
          operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          idempotencyKey,
          correlationId,
          JSON.stringify({
            type: "evaluation.results.export",
            operationId,
            roundId,
          }),
          resultJson,
          rowCount,
          rowCount,
          viewer.eventId,
          viewer.organisationId,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           )
           SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'evaluation.results.exported', 'operation', ?,
                  ?, ?, unixepoch()
            WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)`,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          operationId,
          correlationId,
          resultJson,
          operationId,
        ),
        this.env.DB.prepare(
          `INSERT INTO event_changes (
             event_id, entity_type, entity_id, change_type, correlation_id,
             created_at
           )
           SELECT ?, 'operation', ?, 'created', ?, unixepoch()
            WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)`,
        ).bind(viewer.eventId, operationId, correlationId, operationId),
      ]);
      if ((created.meta.changes ?? 0) !== 1) {
        const concurrent = await this.existingExport(viewer, idempotencyKey);
        if (!concurrent) {
          throw new Error(
            "The Abstract results export could not be recorded in this event.",
          );
        }
        if (
          concurrent.roundId !== roundId ||
          concurrent.rowCount !== rowCount ||
          concurrent.csvSha256 !== csvSha256
        ) {
          throw new EvaluationResultsExportIdempotencyConflictError();
        }
        return {
          body: csvBytes,
          filename: "program-cue-abstract-review-results.csv",
          rowCount,
          operationId: concurrent.operationId,
        };
      }

      return {
        body: csvBytes,
        filename: "program-cue-abstract-review-results.csv",
        rowCount,
        operationId,
      };
    });
  }
}
