import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { parseCsv } from "~/platform/operations/csv";
import { ensureDemoEvaluationData } from "./demo.server";
import { EvaluationResultsExportService } from "./evaluation-results-export.server";

const workerEnv = env as unknown as CloudflareEnvironment;
const eventId = "evt-foe-2025";
const roundId = "demo-evaluation-round";
const firstAssignmentId = "demo-evaluation-assignment-1";
const firstSubmissionId = "demo-evaluation-submission-calm";
const unassignedSubmissionId = "evaluation-results-unassigned-submission";
const largeSubmissionPrefix = "evaluation-results-large-submission-";
const expandedSubmissionPrefix = "evaluation-results-expanded-submission-";
const expandedCriterionPrefix = "evaluation-results-expanded-criterion-";

const administrator: Viewer = {
  personId: "person-demo-admin",
  name: "Jordan Alvarez",
  email: "sbek-organizer@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId,
  demo: true,
};

const scores = {
  "demo-evaluation-criterion-relevance": 5,
  "demo-evaluation-criterion-substance": 4,
  "demo-evaluation-criterion-practicality": 4,
  "demo-evaluation-criterion-delivery": 4,
};

function observeDatabaseBatches(batchShapes: number[][]) {
  const observedDatabase = {
    prepare: workerEnv.DB.prepare.bind(workerEnv.DB),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      const results = await workerEnv.DB.batch<T>(statements);
      batchShapes.push(results.map((result) => result.results.length));
      return results;
    },
  } as D1Database;
  const observedEnv = Object.create(workerEnv) as CloudflareEnvironment;
  Object.defineProperty(observedEnv, "DB", {
    value: observedDatabase,
    enumerable: true,
  });
  return observedEnv;
}

async function submitFirstReview(scoresJson = JSON.stringify(scores)) {
  await workerEnv.DB.batch([
    workerEnv.DB.prepare(
      `UPDATE evaluator_assignments
          SET status = 'submitted', submitted_at = unixepoch()
        WHERE id = ? AND event_id = ?`,
    ).bind(firstAssignmentId, eventId),
    workerEnv.DB.prepare(
      `INSERT INTO reviews (
         id, event_id, assignment_id, status, scores_json, weighted_score,
         recommendation, revision, created_at, updated_at, submitted_at
       ) VALUES (?, ?, ?, 'submitted', ?, 4.25, 'accept', 1,
                 unixepoch(), unixepoch(), unixepoch())`,
    ).bind(
      "evaluation-results-export-review",
      eventId,
      firstAssignmentId,
      scoresJson,
    ),
  ]);
}

async function addLargeReview(index: number, freeText: string) {
  const submissionId = `${largeSubmissionPrefix}${index}`;
  const assignmentId = `evaluation-results-large-assignment-${index}`;
  await workerEnv.DB.batch([
    workerEnv.DB.prepare(
      `INSERT INTO submissions (
         id, event_id, form_version_id, submitter_person_id, submitter_email,
         public_reference, title, category, format, status, answers_json,
         submitted_snapshot_json, revision, submitted_at, created_at, updated_at
       )
       SELECT ?, event_id, form_version_id, submitter_person_id, submitter_email,
              ?, ?, category, format, 'submitted', answers_json,
              submitted_snapshot_json, 1, unixepoch(), unixepoch(), unixepoch()
         FROM submissions WHERE id = ? AND event_id = ?`,
    ).bind(
      submissionId,
      `LARGE-${index}`,
      `Large export evidence ${index}`,
      firstSubmissionId,
      eventId,
    ),
    workerEnv.DB.prepare(
      `INSERT INTO evaluator_assignments (
         id, event_id, round_id, submission_id, evaluator_person_id,
         status, revision, assigned_at, submitted_at
       )
       SELECT ?, event_id, round_id, ?, evaluator_person_id, 'submitted', 1,
              unixepoch(), unixepoch()
         FROM evaluator_assignments WHERE id = ? AND event_id = ?`,
    ).bind(assignmentId, submissionId, firstAssignmentId, eventId),
    workerEnv.DB.prepare(
      `INSERT INTO reviews (
         id, event_id, assignment_id, status, scores_json, weighted_score,
         recommendation, revision, created_at, updated_at, submitted_at
       ) VALUES (?, ?, ?, 'submitted', ?, 4.25, 'accept', 1,
                 unixepoch(), unixepoch(), unixepoch())`,
    ).bind(
      `evaluation-results-large-review-${index}`,
      eventId,
      assignmentId,
      JSON.stringify({
        ...scores,
        "demo-evaluation-criterion-relevance": freeText,
      }),
    ),
  ]);
}

async function addCompactExpandedOutputFixture(submissionCount: number) {
  const criteria = Array.from({ length: 26 }, (_, offset) => {
    const position = offset + 4;
    return workerEnv.DB.prepare(
      `INSERT INTO evaluation_criteria (
         id, event_id, round_id, name, description, input_type, options_json,
         weight_percent, required, position
       ) VALUES (?, ?, ?, ?, '', 'free_text', '[]', 0, 0, ?)`,
    ).bind(
      `${expandedCriterionPrefix}${position}`,
      eventId,
      roundId,
      `Expanded criterion ${position} ${"x".repeat(95)}`,
      position,
    );
  });
  await workerEnv.DB.batch(criteria);
  await workerEnv.DB.prepare(
    `WITH RECURSIVE sequence(value) AS (
       SELECT 1
       UNION ALL
       SELECT value + 1 FROM sequence WHERE value < ?
     )
     INSERT INTO submissions (
       id, event_id, form_version_id, submitter_person_id, submitter_email,
       public_reference, title, category, format, status, answers_json,
       submitted_snapshot_json, revision, submitted_at, created_at, updated_at
     )
     SELECT ? || sequence.value, source.event_id, source.form_version_id,
            source.submitter_person_id, source.submitter_email,
            'EXPANDED-' || sequence.value,
            'Compact expanded export ' || sequence.value,
            source.category, source.format, 'submitted', source.answers_json,
            source.submitted_snapshot_json, 1, unixepoch(), unixepoch(),
            unixepoch()
       FROM submissions source CROSS JOIN sequence
      WHERE source.id = ? AND source.event_id = ?`,
  )
    .bind(submissionCount, expandedSubmissionPrefix, firstSubmissionId, eventId)
    .run();
}

beforeEach(async () => {
  await ensureDemoEvaluationData(workerEnv);
  await workerEnv.DB.batch([
    workerEnv.DB.prepare(
      `DELETE FROM reviews
        WHERE event_id = ? AND assignment_id IN (
          'demo-evaluation-assignment-1', 'demo-evaluation-assignment-2'
        )`,
    ).bind(eventId),
    workerEnv.DB.prepare(
      `UPDATE evaluator_assignments
          SET status = 'assigned', submitted_at = NULL
        WHERE event_id = ? AND round_id = ?`,
    ).bind(eventId, roundId),
    workerEnv.DB.prepare(
      `UPDATE submissions
          SET title = CASE id
            WHEN 'demo-evaluation-submission-calm' THEN '=unsafe abstract'
            WHEN 'demo-evaluation-submission-inclusive'
              THEN 'Designing inclusive attendee journeys'
            ELSE title
          END
        WHERE event_id = ? AND id IN (
          'demo-evaluation-submission-calm',
          'demo-evaluation-submission-inclusive'
        )`,
    ).bind(eventId),
    workerEnv.DB.prepare(
      `DELETE FROM submissions WHERE id = ? AND event_id = ?`,
    ).bind(unassignedSubmissionId, eventId),
    workerEnv.DB.prepare(
      `DELETE FROM submissions WHERE event_id = ? AND id LIKE ?`,
    ).bind(eventId, `${largeSubmissionPrefix}%`),
    workerEnv.DB.prepare(
      `DELETE FROM submissions WHERE event_id = ? AND id LIKE ?`,
    ).bind(eventId, `${expandedSubmissionPrefix}%`),
    workerEnv.DB.prepare(
      `DELETE FROM evaluation_criteria
        WHERE event_id = ? AND round_id = ? AND id LIKE ?`,
    ).bind(eventId, roundId, `${expandedCriterionPrefix}%`),
    workerEnv.DB.prepare(
      `UPDATE evaluation_criteria
          SET input_type = 'scale_5', options_json = '[]'
        WHERE id = 'demo-evaluation-criterion-relevance'
          AND event_id = ? AND round_id = ?`,
    ).bind(eventId, roundId),
    workerEnv.DB.prepare(
      `INSERT INTO submissions (
         id, event_id, form_version_id, submitter_person_id, submitter_email,
         public_reference, title, category, format, status, answers_json,
         submitted_snapshot_json, revision, submitted_at, created_at, updated_at
       )
       SELECT ?, event_id, form_version_id, submitter_person_id, submitter_email,
              'DEMO-EVAL-UNASSIGNED', 'Unassigned export evidence', category,
              format, 'submitted', answers_json, submitted_snapshot_json, 1,
              unixepoch(), unixepoch(), unixepoch()
         FROM submissions WHERE id = ? AND event_id = ?`,
    ).bind(unassignedSubmissionId, firstSubmissionId, eventId),
  ]);
});

describe("Abstract review results export", () => {
  it("exports one safe aggregate row per assigned round and submission", async () => {
    await submitFirstReview();

    const result = await new EvaluationResultsExportService(workerEnv).create(
      administrator,
      roundId,
      crypto.randomUUID(),
    );
    const csv = new TextDecoder().decode(result.body);
    const parsed = parseCsv(csv);
    const eligibleSubmissionCount = await workerEnv.DB.prepare(
      `SELECT COUNT(*) AS total FROM submissions
        WHERE event_id = ? AND status <> 'draft'`,
    )
      .bind(eventId)
      .first<{ total: number }>();

    expect(result.filename).toBe("program-cue-abstract-review-results.csv");
    expect(result.rowCount).toBe(eligibleSubmissionCount!.total);
    expect(parsed.rows).toHaveLength(eligibleSubmissionCount!.total);
    expect(
      new Set(
        parsed.rows.map(
          (row) => `${row.roundId ?? ""}:${row.submissionId ?? ""}`,
        ),
      ).size,
    ).toBe(eligibleSubmissionCount!.total);

    const reviewed = parsed.rows.find(
      (row) => row.submissionId === firstSubmissionId,
    );
    expect(reviewed).toMatchObject({
      roundId,
      roundName: "Initial review",
      submissionTitle: "'=unsafe abstract",
      reviewStatus: "complete",
      assignedReviews: "1",
      completedReviews: "1",
      outstandingReviews: "0",
      aggregateWeightedScore: "4.25",
      recommendation: "accept",
      recommendationBreakdown: JSON.stringify({ accept: 1 }),
    });
    expect(JSON.parse(reviewed!.criterionResults)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          criterion: "Audience relevance",
          inputType: "scale_5",
          responseCount: 1,
          averageScore: 5,
        }),
      ]),
    );

    const outstanding = parsed.rows.find(
      (row) => row.submissionId === "demo-evaluation-submission-inclusive",
    );
    expect(outstanding).toMatchObject({
      reviewStatus: "not_started",
      assignedReviews: "1",
      completedReviews: "0",
      outstandingReviews: "1",
      aggregateWeightedScore: "",
      recommendation: "",
    });

    expect(
      parsed.rows.find((row) => row.submissionId === unassignedSubmissionId),
    ).toMatchObject({
      reviewStatus: "not_assigned",
      assignedReviews: "0",
      completedReviews: "0",
      outstandingReviews: "0",
      recusedReviews: "0",
      cancelledReviews: "0",
      aggregateWeightedScore: "",
      recommendation: "",
    });
  });

  it("fails closed for malformed scorecard references and unauthorised scope", async () => {
    await submitFirstReview(JSON.stringify({ unknownCriterion: 5 }));

    await expect(
      new EvaluationResultsExportService(workerEnv).create(
        administrator,
        roundId,
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/unknown criterion unknownCriterion/u);
    await expect(
      new EvaluationResultsExportService(workerEnv).create(
        {
          ...administrator,
          role: "speaker",
        },
        roundId,
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      new EvaluationResultsExportService(workerEnv).create(
        {
          ...administrator,
          organisationId: "another-organisation",
        },
        roundId,
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/Event not found in the authorised organisation/u);
    await expect(
      new EvaluationResultsExportService(workerEnv).create(
        administrator,
        "round-outside-current-plan",
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/not in the current evaluation plan/u);
  });

  it("rejects a persisted dropdown response outside the exact rubric options", async () => {
    await workerEnv.DB.prepare(
      `UPDATE evaluation_criteria
          SET input_type = 'dropdown', options_json = '["Accept","Reject"]'
        WHERE id = 'demo-evaluation-criterion-relevance'
          AND event_id = ? AND round_id = ?`,
    )
      .bind(eventId, roundId)
      .run();
    await submitFirstReview(
      JSON.stringify({
        ...scores,
        "demo-evaluation-criterion-relevance": "Maybe",
      }),
    );

    await expect(
      new EvaluationResultsExportService(workerEnv).create(
        administrator,
        roundId,
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/not one of its persisted dropdown options/u);
  });

  it("records one audited operation and converges an unchanged retry", async () => {
    const intentKey = crypto.randomUUID();
    const service = new EvaluationResultsExportService(workerEnv);
    const first = await service.create(administrator, roundId, intentKey);
    const repeated = await service.create(administrator, roundId, intentKey);

    expect(repeated.operationId).toBe(first.operationId);
    expect(repeated.body).toEqual(first.body);
    expect(
      await workerEnv.DB.prepare(
        `SELECT organisation_id AS organisationId, event_id AS eventId,
                requested_by_person_id AS requestedByPersonId, status
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(first.operationId)
        .first(),
    ).toEqual({
      organisationId: administrator.organisationId,
      eventId,
      requestedByPersonId: administrator.personId,
      status: "completed",
    });
    expect(
      await workerEnv.DB.prepare(
        `SELECT COUNT(*) AS total FROM audit_events
          WHERE action = 'evaluation.results.exported'
            AND entity_type = 'operation' AND entity_id = ?`,
      )
        .bind(first.operationId)
        .first<{ total: number }>(),
    ).toEqual({ total: 1 });

    await workerEnv.DB.prepare(
      `UPDATE submissions SET title = 'Changed after export'
        WHERE id = ? AND event_id = ?`,
    )
      .bind(firstSubmissionId, eventId)
      .run();
    await expect(
      service.create(administrator, roundId, intentKey),
    ).rejects.toThrow(/different round or data snapshot/u);
  });

  it("converges concurrent creates for the same export intent", async () => {
    const intentKey = crypto.randomUUID();
    const service = new EvaluationResultsExportService(workerEnv);
    const [first, second] = await Promise.all([
      service.create(administrator, roundId, intentKey),
      service.create(administrator, roundId, intentKey),
    ]);

    expect(second.operationId).toBe(first.operationId);
    expect(second.body).toEqual(first.body);
    expect(
      await workerEnv.DB.prepare(
        `SELECT COUNT(*) AS total FROM audit_events
          WHERE action = 'evaluation.results.exported'
            AND entity_type = 'operation' AND entity_id = ?`,
      )
        .bind(first.operationId)
        .first<{ total: number }>(),
    ).toEqual({ total: 1 });
  });

  it("fails closed before loading oversized source data and after oversized CSV expansion", async () => {
    const operationCountBefore = await workerEnv.DB.prepare(
      `SELECT COUNT(*) AS total FROM operation_jobs
        WHERE event_id = ? AND type = 'evaluation.results.export'`,
    )
      .bind(eventId)
      .first<{ total: number }>();
    await workerEnv.DB.prepare(
      `UPDATE evaluation_criteria
          SET input_type = 'free_text'
        WHERE id = 'demo-evaluation-criterion-relevance'
          AND event_id = ? AND round_id = ?`,
    )
      .bind(eventId, roundId)
      .run();
    for (let index = 0; index < 12; index += 1) {
      await addLargeReview(index, '"'.repeat(300 * 1024));
    }

    const batchShapes: number[][] = [];
    const observedEnv = observeDatabaseBatches(batchShapes);

    await expect(
      new EvaluationResultsExportService(observedEnv).create(
        administrator,
        roundId,
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/generated Abstract results CSV exceeds/u);
    expect(batchShapes).toHaveLength(1);
    expect(batchShapes[0]?.[0]).toBe(1);
    expect(batchShapes[0]?.[1]).toBeGreaterThan(0);
    expect(batchShapes[0]?.[2]).toBeGreaterThan(0);

    await addLargeReview(12, '"'.repeat(300 * 1024));
    await addLargeReview(13, '"'.repeat(300 * 1024));
    await expect(
      new EvaluationResultsExportService(observedEnv).create(
        administrator,
        roundId,
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/source data exceeds/u);
    expect(batchShapes).toHaveLength(2);
    expect(batchShapes[1]).toEqual([1, 0, 0]);

    expect(
      (
        await workerEnv.DB.prepare(
          `SELECT COUNT(*) AS total FROM operation_jobs
          WHERE event_id = ? AND type = 'evaluation.results.export'`,
        )
          .bind(eventId)
          .first<{ total: number }>()
      )?.total,
    ).toBe(operationCountBefore?.total);
  });

  it("stops a compact source snapshot when repeated rubric metadata expands past the CSV limit", async () => {
    await addCompactExpandedOutputFixture(1_600);
    const operationCountBefore = await workerEnv.DB.prepare(
      `SELECT COUNT(*) AS total FROM operation_jobs
        WHERE event_id = ? AND type = 'evaluation.results.export'`,
    )
      .bind(eventId)
      .first<{ total: number }>();
    const batchShapes: number[][] = [];
    const observedEnv = observeDatabaseBatches(batchShapes);

    await expect(
      new EvaluationResultsExportService(observedEnv).create(
        administrator,
        roundId,
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/generated Abstract results CSV exceeds/u);

    expect(batchShapes).toEqual([[1, 1_603, 30]]);
    expect(
      (
        await workerEnv.DB.prepare(
          `SELECT COUNT(*) AS total FROM operation_jobs
            WHERE event_id = ? AND type = 'evaluation.results.export'`,
        )
          .bind(eventId)
          .first<{ total: number }>()
      )?.total,
    ).toBe(operationCountBefore?.total);
  });
});
