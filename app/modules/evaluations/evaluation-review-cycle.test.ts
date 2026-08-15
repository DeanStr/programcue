import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoEvaluationData } from "./demo.server";
import {
  EvaluationRevisionConflictError,
  EvaluationService,
  EvaluationStateError,
} from "./evaluation-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Jordan Alvarez",
  email: "sbek-organizer@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const evaluator: Viewer = {
  personId: "person-demo-evaluator",
  name: "Jordan Lee",
  email: "jordan.evaluator@example.com",
  role: "evaluator",
  organisationId: admin.organisationId,
  eventId: admin.eventId,
  demo: true,
};

const newCycleInput = {
  currentPlanId: "demo-evaluation-plan",
  currentPlanRevision: 1,
  expectedRunningAssessmentOperationCount: 0,
  expectedUnfinishedAssignmentCount: 2,
  expectedUnfinishedReviewCount: 0,
  planName: "Second programme committee review",
  round: {
    name: "Second-cycle review",
    opensAt: null,
    closesAt: null,
    anonymous: true,
    criteria: [
      {
        name: "Programme fit",
        description: "Fit for the current programme.",
        inputType: "scale_5" as const,
        options: [],
        weightPercent: 100,
        required: true,
      },
      {
        name: "Reviewer context",
        description: "Optional context for moderation.",
        inputType: "free_text" as const,
        options: [],
        weightPercent: 0,
        required: false,
      },
    ],
  },
  confirmed: true as const,
};

function evaluationEnvironment() {
  return {
    ...(env as unknown as CloudflareEnvironment),
    OPERATIONS_QUEUE: {
      send: async () => undefined,
    },
  } as unknown as CloudflareEnvironment;
}

function withBatchRace(
  testEnv: CloudflareEnvironment,
  race: () => Promise<void>,
) {
  let injectRace = true;
  const racingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (injectRace) {
            injectRace = false;
            await race();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(testEnv, {
    get(target, property) {
      return property === "DB" ? racingDb : Reflect.get(target, property);
    },
  });
}

async function resetCycleFixture() {
  await env.DB.prepare(
    "DELETE FROM organisations WHERE id = 'review-cycle-other-organisation'",
  ).run();
  await env.DB.prepare(
    "DELETE FROM operation_jobs WHERE id LIKE 'review-cycle-ai-%'",
  ).run();
  await env.DB.prepare(
    `DELETE FROM sessions
      WHERE id IN (
        'review-cycle-archived-session',
        'review-cycle-inactive-session'
      ) AND event_id = ?`,
  )
    .bind(admin.eventId)
    .run();
  await env.DB.prepare(
    `DELETE FROM submission_decisions
      WHERE event_id = ?
        AND submission_id IN (
          'demo-evaluation-submission-calm',
          'demo-evaluation-submission-inclusive'
        )`,
  )
    .bind(admin.eventId)
    .run();
  await env.DB.prepare("DELETE FROM evaluation_plans WHERE event_id = ?")
    .bind(admin.eventId)
    .run();
  await env.DB.prepare(
    `UPDATE submissions
        SET status = 'assigned', last_operation_id = NULL,
            revision = revision + 1, updated_at = unixepoch()
      WHERE event_id = ?
        AND id IN (
          'demo-evaluation-submission-calm',
          'demo-evaluation-submission-inclusive'
        )`,
  )
    .bind(admin.eventId)
    .run();
  await ensureDemoEvaluationData(env as unknown as CloudflareEnvironment);
}

async function seedTerminalDecisionCandidates() {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE submissions
          SET status = 'accepted', revision = revision + 1,
              updated_at = unixepoch()
        WHERE id = 'demo-evaluation-submission-calm' AND event_id = ?`,
    ).bind(admin.eventId),
    env.DB.prepare(
      `UPDATE submissions
          SET status = 'rejected', revision = revision + 1,
              updated_at = unixepoch()
        WHERE id = 'demo-evaluation-submission-inclusive' AND event_id = ?`,
    ).bind(admin.eventId),
    env.DB.prepare(
      `INSERT INTO submission_decisions (
         id, event_id, submission_id, round_id, revision_number, status,
         decision, decided_by_person_id, rationale,
         notification_feedback_json, effect_preview_json, idempotency_key,
         decided_at, published_at
       ) VALUES (
         'review-cycle-decision-accepted', ?,
         'demo-evaluation-submission-calm', 'demo-evaluation-round', 1,
         'published', 'accepted', ?, 'Accepted in the first cycle.',
         '[]', '{}', 'review-cycle-decision-accepted',
         unixepoch(), unixepoch()
       )`,
    ).bind(admin.eventId, admin.personId),
    env.DB.prepare(
      `INSERT INTO submission_decisions (
         id, event_id, submission_id, round_id, revision_number, status,
         decision, decided_by_person_id, rationale,
         notification_feedback_json, effect_preview_json, idempotency_key,
         decided_at, published_at
       ) VALUES (
         'review-cycle-decision-rejected', ?,
         'demo-evaluation-submission-inclusive', 'demo-evaluation-round', 1,
         'published', 'rejected', ?, 'Rejected in the first cycle.',
         '[]', '{}', 'review-cycle-decision-rejected',
         unixepoch(), unixepoch()
       )`,
    ).bind(admin.eventId, admin.personId),
  ]);
}

beforeEach(resetCycleFixture);

describe("explicit evaluation review cycles", () => {
  it("does not archive a cycle while its AI assessment operation has a staged result", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json, result_json,
         progress_total, attempt_count, started_at, created_at, updated_at
       ) VALUES (
         'review-cycle-ai-staged', ?, ?, ?,
         'ai.review_assessment.generate', 'review-cycle-ai-staged',
         'review-cycle-ai-staged', 'running', ?, ?, 1, 1,
         unixepoch(), unixepoch(), unixepoch()
       )`,
    )
      .bind(
        admin.organisationId,
        admin.eventId,
        admin.personId,
        JSON.stringify({
          type: "ai.review_assessment.generate",
          roundId: "demo-evaluation-round",
          submissionId: "demo-evaluation-submission-calm",
        }),
        JSON.stringify({
          phase: "provider_completed",
          assessmentId: "review-cycle-ai-assessment",
        }),
      )
      .run();

    const workspace = await service.getAdminWorkspace(admin);
    expect(workspace.reviewCyclePreview).toMatchObject({
      runningAssessmentOperationCount: 1,
    });

    await expect(
      service.startReviewCycle(admin, newCycleInput),
    ).rejects.toThrow(/running AI review assessment/i);
    await expect(
      env.DB.prepare(
        `SELECT status FROM evaluation_plans
          WHERE id = 'demo-evaluation-plan' AND event_id = ?`,
      )
        .bind(admin.eventId)
        .first<{ status: string }>(),
    ).resolves.toEqual({ status: "active" });
    await expect(
      env.DB.prepare(
        `SELECT status, result_json AS resultJson FROM operation_jobs
          WHERE id = 'review-cycle-ai-staged' AND event_id = ?`,
      )
        .bind(admin.eventId)
        .first<{ status: string; resultJson: string }>(),
    ).resolves.toMatchObject({
      status: "running",
      resultJson: expect.stringContaining('"phase":"provider_completed"'),
    });
  });

  it("ignores terminal and cross-tenant AI operations outside the current cycle", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO organisations (id, name, slug, created_at, updated_at)
         VALUES ('review-cycle-other-organisation', 'Other review tenant',
                 'review-cycle-other-organisation', unixepoch(), unixepoch())`,
      ),
      env.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json, revision, created_at, updated_at
         ) SELECT 'review-cycle-other-event',
                  'review-cycle-other-organisation', 'Other event',
                  'review-cycle-other-event', timezone, starts_at, ends_at,
                  file_policy_json, 1, unixepoch(), unixepoch()
             FROM events WHERE id = ? AND organisation_id = ?`,
      ).bind(admin.eventId, admin.organisationId),
      env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, type, idempotency_key,
           correlation_id, status, payload_json, progress_total,
           progress_completed, attempt_count, completed_at, created_at, updated_at
         ) VALUES (
           'review-cycle-ai-completed', ?, ?,
           'ai.review_assessment.generate', 'review-cycle-ai-completed',
           'review-cycle-ai-completed', 'completed', ?, 1, 1, 1,
           unixepoch(), unixepoch(), unixepoch()
         )`,
      ).bind(
        admin.organisationId,
        admin.eventId,
        JSON.stringify({ roundId: "demo-evaluation-round" }),
      ),
      env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, type, idempotency_key,
           correlation_id, status, payload_json, progress_total,
           attempt_count, started_at, created_at, updated_at
         ) VALUES (
           'review-cycle-ai-other-tenant', 'review-cycle-other-organisation',
           'review-cycle-other-event', 'ai.review_assessment.generate',
           'review-cycle-ai-other-tenant', 'review-cycle-ai-other-tenant',
           'running', ?, 1, 1, unixepoch(), unixepoch(), unixepoch()
         )`,
      ).bind(JSON.stringify({ roundId: "demo-evaluation-round" })),
    ]);

    await expect(
      service.startReviewCycle(admin, newCycleInput),
    ).resolves.toMatchObject({ archivedPlanId: "demo-evaluation-plan" });
  });

  it("atomically archives the current plan and rounds while preserving unfinished history", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    const oldAssignment = await env.DB.prepare(
      `SELECT id FROM evaluator_assignments
        WHERE event_id = ? AND round_id = 'demo-evaluation-round'
        ORDER BY id LIMIT 1`,
    )
      .bind(admin.eventId)
      .first<{ id: string }>();
    expect(oldAssignment).not.toBeNull();
    await env.DB.prepare(
      `INSERT INTO reviews (
         id, event_id, assignment_id, status, scores_json, revision,
         created_at, updated_at
       ) VALUES (
         'review-cycle-draft-review', ?, ?, 'draft', '{}', 1,
         unixepoch(), unixepoch()
       )`,
    )
      .bind(admin.eventId, oldAssignment!.id)
      .run();

    const workspace = await service.getAdminWorkspace(admin);
    expect(workspace.reviewCyclePreview).toEqual({
      unfinishedAssignmentCount: 2,
      unfinishedReviewCount: 1,
      runningAssessmentOperationCount: 0,
    });
    const result = await service.startReviewCycle(admin, {
      ...newCycleInput,
      expectedUnfinishedReviewCount: 1,
    });

    expect(result).toMatchObject({
      archivedPlanId: "demo-evaluation-plan",
      unfinishedAssignmentCount: 2,
      unfinishedReviewCount: 1,
    });
    const state = await env.DB.prepare(
      `SELECT
         (SELECT status FROM evaluation_plans
           WHERE id = 'demo-evaluation-plan') AS oldPlanStatus,
         (SELECT status FROM evaluation_rounds
           WHERE id = 'demo-evaluation-round') AS oldRoundStatus,
         (SELECT status FROM evaluation_plans
           WHERE id = ?) AS newPlanStatus,
         (SELECT status FROM evaluation_rounds
           WHERE id = ?) AS newRoundStatus,
         (SELECT COUNT(*) FROM evaluation_criteria
           WHERE round_id = ?) AS newCriterionCount,
         (SELECT status FROM evaluator_assignments
           WHERE id = ?) AS oldAssignmentStatus,
         (SELECT status FROM reviews
           WHERE id = 'review-cycle-draft-review') AS oldReviewStatus,
         (SELECT COUNT(*) FROM audit_events
           WHERE event_id = ? AND action = 'evaluation.review_cycle.started'
             AND entity_id = ?) AS auditCount`,
    )
      .bind(
        result.planId,
        result.roundId,
        result.roundId,
        oldAssignment!.id,
        admin.eventId,
        result.planId,
      )
      .first<{
        oldPlanStatus: string;
        oldRoundStatus: string;
        newPlanStatus: string;
        newRoundStatus: string;
        newCriterionCount: number;
        oldAssignmentStatus: string;
        oldReviewStatus: string;
        auditCount: number;
      }>();
    expect(state).toEqual({
      oldPlanStatus: "archived",
      oldRoundStatus: "archived",
      newPlanStatus: "active",
      newRoundStatus: "active",
      newCriterionCount: 2,
      oldAssignmentStatus: "assigned",
      oldReviewStatus: "draft",
      auditCount: 1,
    });

    const archivedReviewerWorkspace =
      await service.getReviewerWorkspace(evaluator);
    expect(archivedReviewerWorkspace.assignments).toEqual([]);
    await expect(
      service.changeRoundReviewerPool(admin, {
        roundId: "demo-evaluation-round",
        personId: evaluator.personId,
        operation: "remove",
        confirmed: true,
      }),
    ).rejects.toBeInstanceOf(EvaluationStateError);
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM evaluation_round_reviewers
          WHERE event_id = ? AND round_id = 'demo-evaluation-round'
            AND person_id = ?`,
      )
        .bind(admin.eventId, evaluator.personId)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
  });

  it("releases an unpublished decision-ready submission only after its prior cycle is archived", async () => {
    const service = new EvaluationService(evaluationEnvironment());
    const submissionId = "demo-evaluation-submission-calm";
    const priorAssignment = await env.DB.prepare(
      `SELECT assignment.id
         FROM evaluator_assignments assignment
        WHERE assignment.event_id = ?
          AND assignment.round_id = 'demo-evaluation-round'
          AND assignment.submission_id = ?`,
    )
      .bind(admin.eventId, submissionId)
      .first<{ id: string }>();
    expect(priorAssignment).not.toBeNull();
    await env.DB.prepare(
      `UPDATE submissions
          SET status = 'decision_ready', revision = revision + 1,
              updated_at = unixepoch()
        WHERE id = ? AND event_id = ?`,
    )
      .bind(submissionId, admin.eventId)
      .run();

    expect(
      (await service.getAdminWorkspace(admin)).submissions.find(
        (submission) => submission.id === submissionId,
      ),
    ).toMatchObject({
      status: "decision_ready",
      reviewableInCurrentCycle: false,
    });
    await expect(
      service.assign(admin, {
        roundId: "demo-evaluation-round",
        targetType: "submission",
        targetIds: [submissionId],
        evaluatorPersonIds: [evaluator.personId],
      }),
    ).rejects.toBeInstanceOf(EvaluationStateError);

    const cycle = await service.startReviewCycle(admin, newCycleInput);
    await service.changeRoundReviewerPool(admin, {
      roundId: cycle.roundId,
      personId: evaluator.personId,
      operation: "add",
    });
    expect(
      (await service.getAdminWorkspace(admin)).submissions.find(
        (submission) => submission.id === submissionId,
      ),
    ).toMatchObject({
      status: "decision_ready",
      reviewableInCurrentCycle: true,
    });

    const racedService = new EvaluationService(
      withBatchRace(evaluationEnvironment(), async () => {
        await env.DB.prepare(
          `INSERT INTO evaluator_assignments (
             id, event_id, round_id, submission_id, evaluator_person_id,
             status, revision, last_operation_id, assigned_at
           ) VALUES (
             'review-cycle-concurrent-assignment', ?, ?, ?, ?, 'assigned', 1,
             'review-cycle-concurrent-operation', unixepoch()
           )`,
        )
          .bind(admin.eventId, cycle.roundId, submissionId, evaluator.personId)
          .run();
      }),
    );
    await expect(
      racedService.assign(admin, {
        roundId: cycle.roundId,
        targetType: "submission",
        targetIds: [submissionId],
        evaluatorPersonIds: [evaluator.personId],
      }),
    ).rejects.toBeInstanceOf(EvaluationRevisionConflictError);
    await expect(
      env.DB.prepare(
        "SELECT status FROM submissions WHERE id = ? AND event_id = ?",
      )
        .bind(submissionId, admin.eventId)
        .first<{ status: string }>(),
    ).resolves.toEqual({ status: "decision_ready" });

    await env.DB.prepare(
      `DELETE FROM evaluator_assignments
        WHERE id = 'review-cycle-concurrent-assignment' AND event_id = ?`,
    )
      .bind(admin.eventId)
      .run();
    await expect(
      service.assign(admin, {
        roundId: cycle.roundId,
        targetType: "submission",
        targetIds: [submissionId],
        evaluatorPersonIds: [evaluator.personId],
      }),
    ).resolves.toMatchObject({
      createdAssignmentCount: 1,
      requestedAssignmentCount: 1,
    });
    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT status FROM submissions
             WHERE id = ? AND event_id = ?) AS submissionStatus,
           (SELECT status FROM evaluator_assignments
             WHERE id = ?) AS priorAssignmentStatus,
           (SELECT COUNT(*) FROM evaluator_assignments current_assignment
             WHERE current_assignment.event_id = ?
               AND current_assignment.round_id = ?
               AND current_assignment.submission_id = ?) AS currentAssignmentCount`,
      )
        .bind(
          submissionId,
          admin.eventId,
          priorAssignment!.id,
          admin.eventId,
          cycle.roundId,
          submissionId,
        )
        .first<{
          submissionStatus: string;
          priorAssignmentStatus: string;
          currentAssignmentCount: number;
        }>(),
    ).resolves.toEqual({
      submissionStatus: "assigned",
      priorAssignmentStatus: "assigned",
      currentAssignmentCount: 1,
    });
  });

  it("rejects stale preview counts, plan revisions and organisation scope", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await expect(
      service.startReviewCycle(admin, {
        ...newCycleInput,
        expectedUnfinishedAssignmentCount: 1,
      }),
    ).rejects.toBeInstanceOf(EvaluationRevisionConflictError);
    await expect(
      service.startReviewCycle(admin, {
        ...newCycleInput,
        currentPlanRevision: 2,
      }),
    ).rejects.toBeInstanceOf(EvaluationRevisionConflictError);
    await expect(
      service.startReviewCycle(
        { ...admin, organisationId: "another-organisation" },
        newCycleInput,
      ),
    ).rejects.toThrow(/authorised organisation/);

    const current = await env.DB.prepare(
      `SELECT status FROM evaluation_plans
        WHERE id = 'demo-evaluation-plan' AND event_id = ?`,
    )
      .bind(admin.eventId)
      .first<{ status: string }>();
    expect(current?.status).toBe("active");
  });

  it("allows only one concurrent start to replace the current cycle", async () => {
    const firstService = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    const secondService = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );

    const starts = await Promise.allSettled([
      firstService.startReviewCycle(admin, {
        ...newCycleInput,
        planName: "Concurrent cycle A",
      }),
      secondService.startReviewCycle(admin, {
        ...newCycleInput,
        planName: "Concurrent cycle B",
      }),
    ]);
    expect(starts.filter((start) => start.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(starts.filter((start) => start.status === "rejected")).toHaveLength(
      1,
    );
    expect(starts.find((start) => start.status === "rejected")).toMatchObject({
      reason: expect.any(EvaluationRevisionConflictError),
    });
    await expect(
      env.DB.prepare(
        `SELECT
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeCount,
           SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archivedCount
           FROM evaluation_plans WHERE event_id = ?`,
      )
        .bind(admin.eventId)
        .first<{ activeCount: number; archivedCount: number }>(),
    ).resolves.toEqual({ activeCount: 1, archivedCount: 1 });
  });

  it("reviews accepted and rejected submissions only through archived decision provenance", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await seedTerminalDecisionCandidates();
    const cycle = await service.startReviewCycle(admin, newCycleInput);
    const nextRoundId = await service.addNextRound(admin, {
      planId: cycle.planId,
      planRevision: 1,
      name: "Second-cycle final review",
      dueAt: null,
      cloneRoundId: cycle.roundId,
    });
    await service.changeRoundReviewerPool(admin, {
      roundId: cycle.roundId,
      personId: evaluator.personId,
      operation: "add",
    });
    await service.changeRoundReviewerPool(admin, {
      roundId: nextRoundId,
      personId: evaluator.personId,
      operation: "add",
    });

    await expect(
      service.assign(admin, {
        roundId: cycle.roundId,
        targetType: "submission",
        targetIds: [
          "demo-evaluation-submission-calm",
          "demo-evaluation-submission-inclusive",
        ],
        evaluatorPersonIds: [evaluator.personId],
        teamId: null,
      }),
    ).resolves.toMatchObject({
      createdAssignmentCount: 2,
      requestedAssignmentCount: 2,
    });

    const assignments = await env.DB.prepare(
      `SELECT id, submission_id AS submissionId
         FROM evaluator_assignments
        WHERE event_id = ? AND round_id = ?
          AND evaluator_person_id = ?
        ORDER BY submission_id`,
    )
      .bind(admin.eventId, cycle.roundId, evaluator.personId)
      .all<{ id: string; submissionId: string }>();
    expect(assignments.results).toHaveLength(2);
    for (const assignment of assignments.results) {
      const workspace = await service.getReviewerWorkspace(
        evaluator,
        assignment.id,
      );
      const scores = Object.fromEntries(
        workspace.criteria.map((criterion) => [
          criterion.id,
          criterion.inputType === "free_text" ? "Second-cycle context." : 5,
        ]),
      );
      await service.saveReview(evaluator, {
        assignmentId: assignment.id,
        revision: 0,
        scores,
        recommendation: "accept",
        confidence: 5,
        submitterFeedback: "Reviewed in the explicit second cycle.",
        privateNotes: "Prior terminal state remains authoritative.",
        conflictAffirmed: true,
        intent: "submit",
      });
    }

    const acceptedAssignment = assignments.results.find(
      (assignment) =>
        assignment.submissionId === "demo-evaluation-submission-calm",
    )!;
    const moderationId = await service.moderate(admin, {
      roundId: cycle.roundId,
      submissionId: acceptedAssignment.submissionId,
      expectedModerationId: null,
      recommendation: "advance",
      moderatedScore: 5,
      notes: "The second-cycle panel confirms this proposal should advance.",
      status: "confirmed",
      confirmed: true,
    });
    const reopened = await service.reopenReview(admin, {
      assignmentId: acceptedAssignment.id,
      reason: "The reviewer must add material context before advancement.",
      confirmed: true,
    });
    const reopenedWorkspace = await service.getReviewerWorkspace(
      evaluator,
      acceptedAssignment.id,
    );
    await service.saveReview(evaluator, {
      assignmentId: acceptedAssignment.id,
      revision: reopened.revision,
      scores: Object.fromEntries(
        reopenedWorkspace.criteria.map((criterion) => [
          criterion.id,
          criterion.inputType === "free_text" ? "Corrected context." : 5,
        ]),
      ),
      recommendation: "accept",
      confidence: 5,
      submitterFeedback: "Reviewed again in the explicit second cycle.",
      privateNotes: "The released terminal state remains authoritative.",
      conflictAffirmed: true,
      intent: "submit",
    });

    const currentWorkspace = await service.getAdminWorkspace(admin);
    expect(
      currentWorkspace.submissions
        .filter((submission) =>
          assignments.results.some(
            (assignment) => assignment.submissionId === submission.id,
          ),
        )
        .map((submission) => ({
          id: submission.id,
          reviewableInCurrentCycle: submission.reviewableInCurrentCycle,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual([
      {
        id: "demo-evaluation-submission-calm",
        reviewableInCurrentCycle: true,
      },
      {
        id: "demo-evaluation-submission-inclusive",
        reviewableInCurrentCycle: true,
      },
    ]);

    await expect(
      service.advanceRound(admin, {
        fromRoundId: cycle.roundId,
        fromRoundRevision: 1,
        toRoundId: nextRoundId,
        toRoundRevision: 1,
        submissionIds: assignments.results.map(
          (assignment) => assignment.submissionId,
        ),
        evaluatorPersonIds: [evaluator.personId],
        teamId: null,
        confirmed: true,
      }),
    ).resolves.toMatchObject({
      advancedSubmissionCount: 2,
      assignmentCount: 2,
    });

    const terminalStates = await env.DB.prepare(
      `SELECT id, status,
              (SELECT COUNT(*) FROM evaluator_assignments next_assignment
                WHERE next_assignment.event_id = submissions.event_id
                  AND next_assignment.round_id = ?
                  AND next_assignment.submission_id = submissions.id) AS nextAssignmentCount
         FROM submissions
        WHERE event_id = ?
          AND id IN (
            'demo-evaluation-submission-calm',
            'demo-evaluation-submission-inclusive'
          )
        ORDER BY id`,
    )
      .bind(nextRoundId, admin.eventId)
      .all<{ id: string; status: string; nextAssignmentCount: number }>();
    expect(terminalStates.results).toEqual([
      {
        id: "demo-evaluation-submission-calm",
        status: "accepted",
        nextAssignmentCount: 1,
      },
      {
        id: "demo-evaluation-submission-inclusive",
        status: "rejected",
        nextAssignmentCount: 1,
      },
    ]);
    await expect(
      env.DB.prepare(
        "SELECT status FROM review_moderations WHERE id = ? AND event_id = ?",
      )
        .bind(moderationId, admin.eventId)
        .first<{ status: string }>(),
    ).resolves.toEqual({ status: "superseded" });
  });

  it.each(["cancelled", "archived"] as const)(
    "does not reopen a submitted review after its session is %s",
    async (sessionStatus) => {
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const sessionId = "review-cycle-inactive-session";
      const assignmentId = "review-cycle-inactive-session-assignment";
      const reviewId = "review-cycle-inactive-session-review";
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO sessions (
             id, event_id, title, slug, description, format, duration_minutes,
             status, revision, created_at, updated_at
           ) VALUES (
             ?, ?, 'Inactive session target', 'inactive-session-target',
             'This review must remain historical.', 'presentation', 45,
             'unscheduled', 1, unixepoch(), unixepoch()
           )`,
        ).bind(sessionId, admin.eventId),
        env.DB.prepare(
          `INSERT INTO evaluator_assignments (
             id, event_id, round_id, session_id, session_snapshot_json,
             evaluator_person_id, status, revision, assigned_at, submitted_at
           ) VALUES (
             ?, ?, 'demo-evaluation-round', ?, '{}', ?, 'submitted', 1,
             unixepoch(), unixepoch()
           )`,
        ).bind(assignmentId, admin.eventId, sessionId, evaluator.personId),
        env.DB.prepare(
          `INSERT INTO reviews (
             id, event_id, assignment_id, status, scores_json, revision,
             created_at, updated_at, submitted_at
           ) VALUES (
             ?, ?, ?, 'submitted', '{}', 1, unixepoch(), unixepoch(), unixepoch()
           )`,
        ).bind(reviewId, admin.eventId, assignmentId),
      ]);
      await env.DB.prepare(
        "UPDATE sessions SET status = ?, revision = revision + 1 WHERE id = ? AND event_id = ?",
      )
        .bind(sessionStatus, sessionId, admin.eventId)
        .run();

      await expect(
        service.reopenReview(admin, {
          assignmentId,
          reason: "This inactive session review must stay in history.",
          confirmed: true,
        }),
      ).rejects.toBeInstanceOf(EvaluationStateError);
      await expect(
        env.DB.prepare(
          `SELECT assignment.status AS assignmentStatus,
                  review.status AS reviewStatus
             FROM evaluator_assignments assignment
             JOIN reviews review
               ON review.assignment_id = assignment.id
              AND review.event_id = assignment.event_id
            WHERE assignment.id = ? AND assignment.event_id = ?`,
        )
          .bind(assignmentId, admin.eventId)
          .first<{ assignmentStatus: string; reviewStatus: string }>(),
      ).resolves.toEqual({
        assignmentStatus: "submitted",
        reviewStatus: "submitted",
      });
    },
  );

  it("fails closed when terminal decision provenance belongs to the current cycle or is revoked", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await seedTerminalDecisionCandidates();
    const cycle = await service.startReviewCycle(admin, newCycleInput);
    await service.changeRoundReviewerPool(admin, {
      roundId: cycle.roundId,
      personId: evaluator.personId,
      operation: "add",
    });
    await env.DB.prepare(
      `UPDATE submission_decisions SET round_id = ?
        WHERE id = 'review-cycle-decision-rejected'`,
    )
      .bind(cycle.roundId)
      .run();

    await expect(
      service.assign(admin, {
        roundId: cycle.roundId,
        targetType: "submission",
        targetIds: ["demo-evaluation-submission-inclusive"],
        evaluatorPersonIds: [evaluator.personId],
        teamId: null,
      }),
    ).rejects.toBeInstanceOf(EvaluationStateError);

    await env.DB.prepare(
      `UPDATE submission_decisions SET round_id = 'demo-evaluation-round'
        WHERE id = 'review-cycle-decision-rejected'`,
    ).run();
    await service.assign(admin, {
      roundId: cycle.roundId,
      targetType: "submission",
      targetIds: ["demo-evaluation-submission-inclusive"],
      evaluatorPersonIds: [evaluator.personId],
      teamId: null,
    });
    const assignment = await env.DB.prepare(
      `SELECT id FROM evaluator_assignments
        WHERE event_id = ? AND round_id = ?
          AND submission_id = 'demo-evaluation-submission-inclusive'
          AND evaluator_person_id = ?`,
    )
      .bind(admin.eventId, cycle.roundId, evaluator.personId)
      .first<{ id: string }>();
    expect(assignment).not.toBeNull();
    await env.DB.prepare(
      `UPDATE submission_decisions SET status = 'revoked'
        WHERE id = 'review-cycle-decision-rejected'`,
    ).run();

    await expect(
      service.saveReview(evaluator, {
        assignmentId: assignment!.id,
        revision: 0,
        scores: {},
        recommendation: null,
        confidence: null,
        submitterFeedback: "",
        privateNotes: "",
        intent: "save",
      }),
    ).rejects.toBeInstanceOf(EvaluationStateError);
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM reviews WHERE assignment_id = ?",
      )
        .bind(assignment!.id)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE evaluator_assignments
            SET status = 'submitted', submitted_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(assignment!.id, admin.eventId),
      env.DB.prepare(
        `INSERT INTO reviews (
           id, event_id, assignment_id, status, scores_json, revision,
           created_at, updated_at, submitted_at
         ) VALUES (
           'review-cycle-revoked-provenance-review', ?, ?, 'submitted', '{}',
           1, unixepoch(), unixepoch(), unixepoch()
         )`,
      ).bind(admin.eventId, assignment!.id),
    ]);
    await expect(
      service.moderate(admin, {
        roundId: cycle.roundId,
        submissionId: "demo-evaluation-submission-inclusive",
        expectedModerationId: null,
        recommendation: "reject",
        moderatedScore: 2,
        notes: "This must not use revoked first-cycle provenance.",
        status: "confirmed",
        confirmed: true,
      }),
    ).rejects.toBeInstanceOf(EvaluationRevisionConflictError);
    await expect(
      service.reopenReview(admin, {
        assignmentId: assignment!.id,
        reason: "This must not use revoked first-cycle decision provenance.",
        confirmed: true,
      }),
    ).rejects.toBeInstanceOf(EvaluationStateError);
  });

  it("does not reuse archived review evidence for a new decision", async () => {
    const service = new EvaluationService(evaluationEnvironment());
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE evaluator_assignments
            SET status = 'submitted', revision = revision + 1
          WHERE id = 'demo-evaluation-assignment-1' AND event_id = ?`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `INSERT INTO reviews (
           id, event_id, assignment_id, status, scores_json, weighted_score,
           recommendation, confidence, revision, created_at, updated_at,
           submitted_at, locked_at
         ) VALUES (
           'review-cycle-completed-review', ?,
           'demo-evaluation-assignment-1', 'submitted', '{}', 4.5,
           'accept', 5, 1, unixepoch(), unixepoch(), unixepoch(), unixepoch()
         )`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, description, format, duration_minutes,
           status, revision, created_at, updated_at
         ) VALUES (
           'review-cycle-archived-session', ?, 'Archived-cycle session',
           'archived-cycle-session', 'Reviewed only in the first cycle.',
           'presentation', 45, 'unscheduled', 1, unixepoch(), unixepoch()
         )`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `INSERT INTO evaluator_assignments (
           id, event_id, round_id, session_id, session_snapshot_json,
           evaluator_person_id, status, revision, assigned_at, submitted_at
         ) VALUES (
           'review-cycle-archived-session-assignment', ?,
           'demo-evaluation-round', 'review-cycle-archived-session', '{}',
           ?, 'submitted', 1, unixepoch(), unixepoch()
         )`,
      ).bind(admin.eventId, evaluator.personId),
      env.DB.prepare(
        `INSERT INTO reviews (
           id, event_id, assignment_id, status, scores_json, weighted_score,
           recommendation, confidence, revision, created_at, updated_at,
           submitted_at, locked_at
         ) VALUES (
           'review-cycle-archived-session-review', ?,
           'review-cycle-archived-session-assignment', 'submitted', '{}', 4.25,
           'accept', 5, 1, unixepoch(), unixepoch(), unixepoch(), unixepoch()
         )`,
      ).bind(admin.eventId),
    ]);
    await service.startReviewCycle(admin, {
      ...newCycleInput,
      expectedUnfinishedAssignmentCount: 1,
    });

    const currentWorkspace = await service.getAdminWorkspace(admin);
    expect(currentWorkspace.assignments).toEqual([]);
    expect(
      currentWorkspace.submissions.find(
        (submission) => submission.id === "demo-evaluation-submission-calm",
      ),
    ).toMatchObject({
      assignmentCount: 0,
      completedReviewCount: 0,
      averageScore: null,
    });
    expect(
      currentWorkspace.sessions.find(
        (session) => session.id === "review-cycle-archived-session",
      ),
    ).toMatchObject({
      assignmentCount: 0,
      completedReviewCount: 0,
      averageScore: null,
    });
    const decisionDialogHasCompletedReview = currentWorkspace.assignments.some(
      (assignment) =>
        assignment.submissionId === "demo-evaluation-submission-calm" &&
        (assignment.reviewStatus === "submitted" ||
          assignment.reviewStatus === "locked"),
    );
    expect(decisionDialogHasCompletedReview).toBe(false);

    const decisionInput = {
      submissionId: "demo-evaluation-submission-calm",
      decision: "rejected" as const,
      sessionTrackId: null,
      rationale: "Not selected for this programme.",
      release: true,
    };
    await expect(service.decide(admin, decisionInput)).rejects.toThrow(
      /confirm the review-evidence override/i,
    );
    const decision = await service.decide(admin, {
      ...decisionInput,
      confirmedWithoutReview: true,
    });
    await expect(
      env.DB.prepare(
        `SELECT round_id AS roundId FROM submission_decisions
          WHERE id = ? AND event_id = ?`,
      )
        .bind(decision.decisionId, admin.eventId)
        .first<{ roundId: string | null }>(),
    ).resolves.toEqual({ roundId: null });
  });

  it("leaves unfinished archived assignments immutable when publishing a decision", async () => {
    const service = new EvaluationService(evaluationEnvironment());
    await service.startReviewCycle(admin, newCycleInput);

    await service.decide(admin, {
      submissionId: "demo-evaluation-submission-calm",
      decision: "rejected",
      sessionTrackId: null,
      rationale: "Decision released after the first cycle was archived.",
      release: true,
      confirmedWithoutReview: true,
    });
    await expect(
      env.DB.prepare(
        `SELECT status, revision, cancellation_reason AS cancellationReason
           FROM evaluator_assignments
          WHERE id = 'demo-evaluation-assignment-1' AND event_id = ?`,
      )
        .bind(admin.eventId)
        .first<{
          status: string;
          revision: number;
          cancellationReason: string | null;
        }>(),
    ).resolves.toEqual({
      status: "assigned",
      revision: 1,
      cancellationReason: null,
    });
  });
});
