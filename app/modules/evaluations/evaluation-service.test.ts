import { env } from "cloudflare:test";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { formSchemaSchema } from "~/modules/submissions/submission-schema";
import { ensureDemoEvaluationData } from "./demo.server";
import {
  EvaluationRevisionConflictError,
  EvaluationService,
  EvaluationValidationError,
} from "./evaluation-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
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
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const committeeChair: Viewer = {
  ...admin,
  personId: admin.personId,
  name: "Casey Chair",
  email: "casey.chair@example.com",
  role: "committee_chair",
};

const criteria = [
  {
    id: "eval-test-relevance",
    name: "Relevance",
    description: "",
    weightPercent: 25,
    position: 0,
  },
  {
    id: "eval-test-originality",
    name: "Originality",
    description: "",
    weightPercent: 20,
    position: 1,
  },
  {
    id: "eval-test-quality",
    name: "Quality",
    description: "",
    weightPercent: 25,
    position: 2,
  },
  {
    id: "eval-test-practical",
    name: "Practical",
    description: "",
    weightPercent: 20,
    position: 3,
  },
  {
    id: "eval-test-expertise",
    name: "Expertise",
    description: "",
    weightPercent: 10,
    position: 4,
  },
] as const;

function submittedSnapshot(
  answers: Record<string, string | string[]> = {},
  formVersionId = "eval-test-form-v1",
) {
  return JSON.stringify({
    formVersionId,
    versionNumber: 1,
    schema: {
      introduction: "",
      fields: [
        {
          id: "title",
          label: "Title",
          type: "short_text",
          required: true,
          help: "",
          options: [],
          condition: null,
        },
        {
          id: "category",
          label: "Category",
          type: "short_text",
          required: true,
          help: "",
          options: [],
          condition: null,
        },
        {
          id: "format",
          label: "Format",
          type: "short_text",
          required: true,
          help: "",
          options: [],
          condition: null,
        },
        {
          id: "description",
          label: "Description",
          type: "long_text",
          required: true,
          help: "",
          options: [],
          reviewVisibility: "reviewers",
          condition: null,
        },
        {
          id: "biography",
          label: "Speaker biography",
          type: "long_text",
          required: false,
          help: "",
          options: [],
          reviewVisibility: "administrators_only",
          condition: null,
        },
      ],
    },
    answers,
    speakers: [{ name: "Alex Morgan", email: "alex.submitter@example.com" }],
  });
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

describe("evaluation demo data", () => {
  afterAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM evaluation_plans WHERE id = 'demo-evaluation-plan'",
      ),
      env.DB.prepare(
        "DELETE FROM submissions WHERE id LIKE 'demo-evaluation-submission-%'",
      ),
      env.DB.prepare(
        "DELETE FROM form_definitions WHERE id = 'demo-evaluation-form'",
      ),
    ]);
  });

  it("is demo-only, idempotent and produces real tenant-scoped evaluation workspaces", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoEvaluationData({
      DB: env.DB,
      DEMO_MODE: "false",
    } as unknown as CloudflareEnvironment);
    expect(
      await env.DB.prepare(
        "SELECT id FROM evaluation_plans WHERE id = 'demo-evaluation-plan'",
      ).first(),
    ).toBeNull();

    await ensureDemoEvaluationData(testEnv);
    await ensureDemoEvaluationData(testEnv);

    const [form, version, submissions, speakers, rubric, assignments, reviews] =
      await Promise.all([
        env.DB.prepare(
          `
        SELECT f.id, f.status, e.organisation_id AS organisationId
          FROM form_definitions f JOIN events e ON e.id = f.event_id
         WHERE f.id = 'demo-evaluation-form'
      `,
        ).first<{ id: string; status: string; organisationId: string }>(),
        env.DB.prepare(
          `
        SELECT schema_json AS schemaJson, routing_json AS routingJson,
               settings_snapshot_json AS settingsJson
          FROM form_versions
         WHERE id = 'demo-evaluation-form-v1'
      `,
        ).first<{
          schemaJson: string;
          routingJson: string;
          settingsJson: string;
        }>(),
        env.DB.prepare(
          `
        SELECT id, status, submitted_at AS submittedAt
          FROM submissions
         WHERE id LIKE 'demo-evaluation-submission-%'
         ORDER BY id
      `,
        ).all<{ id: string; status: string; submittedAt: number | null }>(),
        env.DB.prepare(
          `
        SELECT id, submission_id AS submissionId, display_name AS displayName
          FROM submission_speakers
         WHERE id LIKE 'demo-evaluation-speaker-%'
         ORDER BY id
      `,
        ).all<{ id: string; submissionId: string; displayName: string }>(),
        env.DB.prepare(
          `
        SELECT r.status, COUNT(c.id) AS criterionCount,
               COALESCE(SUM(c.weight_percent), 0) AS totalWeight
          FROM evaluation_rounds r
          LEFT JOIN evaluation_criteria c ON c.round_id = r.id AND c.event_id = r.event_id
         WHERE r.id = 'demo-evaluation-round' AND r.event_id = ?
         GROUP BY r.id
      `,
        )
          .bind(admin.eventId)
          .first<{
            status: string;
            criterionCount: number;
            totalWeight: number;
          }>(),
        env.DB.prepare(
          `
        SELECT a.id, a.event_id AS eventId, a.evaluator_person_id AS evaluatorPersonId
          FROM evaluator_assignments a
         WHERE a.id LIKE 'demo-evaluation-assignment-%'
         ORDER BY a.id
      `,
        ).all<{ id: string; eventId: string; evaluatorPersonId: string }>(),
        env.DB.prepare(
          `
        SELECT COUNT(*) AS count
          FROM reviews r JOIN evaluator_assignments a ON a.id = r.assignment_id
         WHERE a.id LIKE 'demo-evaluation-assignment-%'
      `,
        ).first<{ count: number }>(),
      ]);

    expect(form).toEqual({
      id: "demo-evaluation-form",
      status: "archived",
      organisationId: admin.organisationId,
    });
    expect(
      formSchemaSchema.parse(JSON.parse(version?.schemaJson ?? "null")).fields,
    ).toHaveLength(6);
    expect(JSON.parse(version?.routingJson ?? "null")).toMatchObject({
      passwordHash: null,
    });
    expect(JSON.parse(version?.settingsJson ?? "null")).toMatchObject({
      minSpeakers: 1,
      maxSpeakers: 2,
    });
    expect(submissions.results).toHaveLength(2);
    expect(
      submissions.results.every(
        (submission) =>
          submission.status === "assigned" && submission.submittedAt !== null,
      ),
    ).toBe(true);
    expect(speakers.results.map((speaker) => speaker.displayName)).toEqual([
      "Alex Morgan",
      "Priya Shah",
    ]);
    expect(rubric).toEqual({
      status: "active",
      criterionCount: 4,
      totalWeight: 100,
    });
    expect(assignments.results).toHaveLength(2);
    expect(
      assignments.results.every(
        (assignment) =>
          assignment.eventId === admin.eventId &&
          assignment.evaluatorPersonId === evaluator.personId,
      ),
    ).toBe(true);
    expect(reviews?.count).toBe(0);

    const service = new EvaluationService(testEnv);
    const adminWorkspace = await service.getAdminWorkspace(admin);
    expect(adminWorkspace.plan?.id).toBe("demo-evaluation-plan");
    expect(
      adminWorkspace.submissions.filter((submission) =>
        submission.id.startsWith("demo-evaluation-submission-"),
      ),
    ).toHaveLength(2);

    const reviewerWorkspace = await service.getReviewerWorkspace(evaluator);
    expect(reviewerWorkspace.assignments).toHaveLength(2);
    expect(reviewerWorkspace.selected?.id).toBe("demo-evaluation-assignment-1");
    expect(
      reviewerWorkspace.criteria.reduce(
        (sum, criterion) => sum + criterion.weightPercent,
        0,
      ),
    ).toBe(100);
    expect(reviewerWorkspace.submission?.speakerNames).toEqual(["Alex Morgan"]);
    expect(reviewerWorkspace.review).toBeNull();
  });
});

describe("evaluation vertical slice", () => {
  beforeEach(async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO form_definitions (id, event_id, name, kind, status, public_slug, min_speakers, max_speakers, access_mode, revision, created_by_person_id, created_at, updated_at) VALUES ('eval-test-form', ?, 'Evaluation fixture', 'submission', 'published', 'eval-test-form', 1, 4, 'email_verified', 1, ?, unixepoch(), unixepoch())`,
      ).bind(admin.eventId, admin.personId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO form_versions (id, event_id, form_id, version_number, schema_json, routing_json, settings_snapshot_json, status, revision, published_at, created_by_person_id, created_at, updated_at) VALUES ('eval-test-form-v1', ?, 'eval-test-form', 1, '[]', '{}', '{}', 'published', 1, unixepoch(), ?, unixepoch(), unixepoch())`,
      ).bind(admin.eventId, admin.personId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO submissions (id, event_id, form_version_id, submitter_person_id, submitter_email, public_reference, title, category, format, status, answers_json, submitted_snapshot_json, revision, submitted_at, created_at, updated_at) VALUES ('eval-test-submission', ?, 'eval-test-form-v1', 'person-demo-submitter', 'alex.submitter@example.com', 'SUB-EVAL-1', 'A practical event proposal', 'Operations', 'Presentation', 'submitted', ?, ?, 1, unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        admin.eventId,
        JSON.stringify({
          abstract: "A clear, useful proposal.",
          description: "A practical description for the public programme.",
          biography: "Alex Morgan is the identifying speaker biography.",
        }),
        submittedSnapshot({
          abstract: "A clear, useful proposal.",
          description: "A practical description for the public programme.",
          biography: "Alex Morgan is the identifying speaker biography.",
        }),
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO submission_speakers (id, event_id, submission_id, person_id, email, display_name, position, invitation_status, is_primary, claimed_at, created_at, updated_at) VALUES ('eval-test-speaker', ?, 'eval-test-submission', 'person-demo-submitter', 'alex.submitter@example.com', 'Alex Morgan', 0, 'claimed', 1, unixepoch(), unixepoch(), unixepoch())`,
      ).bind(admin.eventId),
    ]);
  });

  it("requires an explicit plan grant before a committee chair releases a decision", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    try {
      await env.DB.prepare(
        `
        INSERT INTO evaluation_plans (
          id, event_id, name, status, blinded_reviewing, decision_role,
          revision, created_by_person_id, created_at, updated_at
        ) VALUES (
          'eval-chair-authority-plan', ?, 'Chair authority plan', 'active', 0,
          'administrator', 1, ?, unixepoch(), unixepoch()
        )
      `,
      )
        .bind(admin.eventId, admin.personId)
        .run();

      await expect(
        service.decide(committeeChair, {
          submissionId: "eval-test-submission",
          decision: "accepted",
          rationale: "Ready for release.",
          release: true,
        }),
      ).rejects.toThrow(/explicitly grants.*committee chairs/i);

      for (const status of ["draft", "closed"] as const) {
        await env.DB.prepare(
          `
          UPDATE evaluation_plans
             SET status = ?, decision_role = 'committee_chair'
           WHERE id = 'eval-chair-authority-plan'
        `,
        )
          .bind(status)
          .run();
        await expect(
          service.decide(committeeChair, {
            submissionId: "eval-test-submission",
            decision: "accepted",
            rationale: "Inactive plans must not grant release authority.",
            release: true,
          }),
        ).rejects.toThrow(/explicitly grants.*committee chairs/i);
      }

      await env.DB.prepare(
        `
        UPDATE evaluation_plans
           SET status = 'active', decision_role = 'committee_chair'
         WHERE id = 'eval-chair-authority-plan'
      `,
      ).run();
      let intercepted = false;
      const boundaryDb = new Proxy(env.DB, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (!intercepted) {
                intercepted = true;
                await target
                  .prepare(
                    "UPDATE evaluation_plans SET status = 'closed' WHERE id = 'eval-chair-authority-plan'",
                  )
                  .run();
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await expect(
        new EvaluationService({
          ...(env as unknown as CloudflareEnvironment),
          DB: boundaryDb,
        }).decide(committeeChair, {
          submissionId: "eval-test-submission",
          decision: "accepted",
          rationale: "The authority must still exist at the write boundary.",
          release: true,
        }),
      ).rejects.toThrow(/explicitly grants.*committee chairs/i);
      expect(
        (
          await env.DB.prepare(
            "SELECT status FROM submissions WHERE id = 'eval-test-submission'",
          ).first<{ status: string }>()
        )?.status,
      ).toBe("submitted");
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM submission_decisions WHERE submission_id = 'eval-test-submission'",
        ).first(),
      ).toEqual({ count: 0 });
    } finally {
      await env.DB.prepare(
        "DELETE FROM evaluation_plans WHERE id = 'eval-chair-authority-plan'",
      ).run();
    }
  });

  it("persists blinded review, redacts identities, submits and locks the review", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await service.savePlan(admin, {
      revision: 0,
      name: "Test review plan",
      status: "active",
      rounds: [
        {
          id: "eval-test-round",
          name: "Initial review",
          anonymous: true,
          criteria,
        },
      ],
    });
    await service.assign(admin, {
      roundId: "eval-test-round",
      submissionIds: ["eval-test-submission"],
      evaluatorPersonIds: [evaluator.personId],
    });

    const workspace = await service.getReviewerWorkspace(evaluator);
    expect(workspace.selected?.submissionId).toBe("eval-test-submission");
    expect(workspace.selected?.blindedReviewing).toBe(true);
    expect(workspace.selected).toMatchObject({
      title: "Blinded proposal",
      category: null,
      format: null,
    });
    expect(workspace.submission).toMatchObject({
      blindedReviewing: true,
      title: "Blinded proposal",
      category: null,
      format: null,
      submitterEmail: null,
      speakerNames: [],
      answers: {
        description: "A practical description for the public programme.",
      },
    });
    expect(workspace.submission).not.toHaveProperty("answersJson");
    expect(workspace.submission).not.toHaveProperty("snapshotJson");
    expect(JSON.stringify(workspace.submission)).not.toContain(
      "alex.submitter@example.com",
    );
    expect(JSON.stringify(workspace.submission)).not.toContain(
      "identifying speaker biography",
    );
    expect(
      await env.DB.prepare(
        "SELECT blinded_reviewing AS blindedReviewing FROM evaluation_plans WHERE name = 'Test review plan'",
      ).first(),
    ).toEqual({ blindedReviewing: 1 });
    const scores = Object.fromEntries(
      criteria.map((criterion, index) => [criterion.id, index === 2 ? 5 : 4]),
    );
    const draft = await service.saveReview(evaluator, {
      assignmentId: workspace.selected!.id,
      revision: 0,
      scores,
      recommendation: null,
      confidence: null,
      submitterFeedback: "Useful proposal.",
      privateNotes: "",
      intent: "save",
    });
    expect(draft.revision).toBe(1);

    await expect(
      service.saveReview(evaluator, {
        assignmentId: workspace.selected!.id,
        revision: 1,
        scores: { [criteria[0]!.id]: 4 },
        recommendation: "accept",
        confidence: 4,
        submitterFeedback: "Useful proposal.",
        privateNotes: "Recommend acceptance.",
        intent: "submit",
      }),
    ).rejects.toBeInstanceOf(EvaluationValidationError);

    const submitted = await service.saveReview(evaluator, {
      assignmentId: workspace.selected!.id,
      revision: 1,
      scores,
      recommendation: "accept",
      confidence: 4,
      submitterFeedback: "Useful proposal.",
      privateNotes: "Recommend acceptance.",
      intent: "submit",
    });
    expect(submitted.weightedScore).toBe(4.25);
    const stored = await env.DB.prepare(
      "SELECT status, revision FROM reviews WHERE id = ?",
    )
      .bind(submitted.reviewId)
      .first<{ status: string; revision: number }>();
    expect(stored).toEqual({ status: "submitted", revision: 2 });
    const submittedWorkspace = await service.getReviewerWorkspace(evaluator);
    expect(submittedWorkspace.selected?.status).toBe("submitted");
    expect(submittedWorkspace.review?.status).toBe("submitted");
    await expect(
      service.saveReview(evaluator, {
        assignmentId: workspace.selected!.id,
        revision: 2,
        scores,
        recommendation: "reject",
        confidence: 5,
        submitterFeedback: "",
        privateNotes: "",
        intent: "submit",
      }),
    ).rejects.toThrow(/unavailable|already submitted/);
  });

  it("rejects an explicit unknown assignment instead of opening another review", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    let adminWorkspace = await service.getAdminWorkspace(admin);
    if (!adminWorkspace.plan?.rounds[0]) {
      await service.savePlan(admin, {
        revision: 0,
        name: "Explicit selection plan",
        status: "active",
        rounds: [
          {
            id: "eval-explicit-selection-round",
            name: "Initial review",
            anonymous: false,
            criteria,
          },
        ],
      });
      adminWorkspace = await service.getAdminWorkspace(admin);
    }
    const roundId =
      adminWorkspace.plan!.rounds.find((round) => round.status === "active")
        ?.id ?? adminWorkspace.plan!.rounds[0]!.id;
    await env.DB.prepare(
      "UPDATE evaluation_rounds SET status = 'active' WHERE id = ? AND event_id = ?",
    )
      .bind(roundId, admin.eventId)
      .run();
    await env.DB.prepare(
      `
      INSERT OR IGNORE INTO submissions (
        id, event_id, form_version_id, submitter_person_id, submitter_email,
        public_reference, title, status, answers_json, submitted_snapshot_json,
        revision, submitted_at, created_at, updated_at
      ) VALUES (
        'eval-explicit-selection-submission', ?, 'eval-test-form-v1',
        'person-demo-submitter', 'alex.submitter@example.com',
        'SUB-EVAL-EXPLICIT-SELECTION', 'Explicit selection proposal', 'submitted',
        '{}', ?, 1, unixepoch(), unixepoch(), unixepoch()
      )
    `,
    )
      .bind(admin.eventId, submittedSnapshot())
      .run();
    await service.assign(admin, {
      roundId,
      submissionIds: ["eval-explicit-selection-submission"],
      evaluatorPersonIds: [evaluator.personId],
    });

    await expect(
      service.getReviewerWorkspace(evaluator, "missing-assignment"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("removes a recused assignment from the evaluator workspace", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await env.DB.batch([
      env.DB.prepare(
        `
        INSERT INTO evaluation_plans (
          id, event_id, name, status, decision_role, revision,
          created_by_person_id, created_at, updated_at
        ) VALUES (
          'eval-recused-access-plan', ?, 'Recused access plan', 'active',
          'administrator', 1, ?, unixepoch(), unixepoch()
        )
      `,
      ).bind(admin.eventId, admin.personId),
      env.DB.prepare(
        `
        INSERT INTO evaluation_rounds (
          id, event_id, plan_id, round_number, name, status, revision,
          created_at, updated_at
        ) VALUES (
          'eval-recused-access-round', ?, 'eval-recused-access-plan', 1,
          'Initial review', 'active', 1, unixepoch(), unixepoch()
        )
      `,
      ).bind(admin.eventId),
      env.DB.prepare(
        `
        INSERT INTO evaluator_assignments (
          id, event_id, round_id, submission_id, evaluator_person_id,
          status, revision, conflict_declared_at, assigned_at
        ) VALUES (
          'eval-recused-access-assignment', ?, 'eval-recused-access-round',
          'eval-test-submission', ?, 'recused', 2, unixepoch(), unixepoch()
        )
      `,
      ).bind(admin.eventId, evaluator.personId),
    ]);
    try {
      const workspace = await service.getReviewerWorkspace(evaluator);
      expect(
        workspace.assignments.map((assignment) => assignment.id),
      ).not.toContain("eval-recused-access-assignment");
      await expect(
        service.getReviewerWorkspace(
          evaluator,
          "eval-recused-access-assignment",
        ),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await env.DB.prepare(
        "DELETE FROM evaluation_plans WHERE id = 'eval-recused-access-plan'",
      ).run();
    }
  });

  it("rejects a reviewable submission without a valid immutable snapshot", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    let adminWorkspace = await service.getAdminWorkspace(admin);
    if (!adminWorkspace.plan?.rounds[0]) {
      await service.savePlan(admin, {
        revision: 0,
        name: "Snapshot invariant plan",
        status: "active",
        rounds: [
          {
            id: "eval-snapshot-invariant-round",
            name: "Initial review",
            anonymous: false,
            criteria,
          },
        ],
      });
      adminWorkspace = await service.getAdminWorkspace(admin);
    }
    const roundId =
      adminWorkspace.plan!.rounds.find((round) => round.status === "active")
        ?.id ?? adminWorkspace.plan!.rounds[0]!.id;
    await env.DB.prepare(
      "UPDATE evaluation_rounds SET status = 'active' WHERE id = ? AND event_id = ?",
    )
      .bind(roundId, admin.eventId)
      .run();
    await env.DB.prepare(
      `
      INSERT OR IGNORE INTO submissions (
        id, event_id, form_version_id, submitter_person_id, submitter_email,
        public_reference, title, status, answers_json, submitted_snapshot_json,
        revision, submitted_at, created_at, updated_at
      ) VALUES (
        'eval-invalid-snapshot-submission', ?, 'eval-test-form-v1',
        'person-demo-submitter', 'alex.submitter@example.com',
        'SUB-EVAL-INVALID-SNAPSHOT', 'Invalid snapshot proposal', 'submitted',
        '{}', ?, 1, unixepoch(), unixepoch(), unixepoch()
      )
    `,
    )
      .bind(admin.eventId, submittedSnapshot())
      .run();
    await service.assign(admin, {
      roundId,
      submissionIds: ["eval-invalid-snapshot-submission"],
      evaluatorPersonIds: [evaluator.personId],
    });
    await env.DB.prepare(
      "UPDATE submissions SET submitted_snapshot_json = '{}' WHERE id = 'eval-invalid-snapshot-submission'",
    ).run();
    const assignment = await env.DB.prepare(
      `
      SELECT id FROM evaluator_assignments
       WHERE event_id = ? AND submission_id = ? AND evaluator_person_id = ?
    `,
    )
      .bind(
        admin.eventId,
        "eval-invalid-snapshot-submission",
        evaluator.personId,
      )
      .first<{ id: string }>();
    expect(assignment).toBeDefined();
    await expect(
      service.getReviewerWorkspace(evaluator, assignment!.id),
    ).rejects.toThrow(/valid immutable submitted snapshot/i);
  });

  it("does not create an assignment when a decision wins after validation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const service = new EvaluationService(testEnv);
    let workspace = await service.getAdminWorkspace(admin);
    if (!workspace.plan?.rounds[0]) {
      await service.savePlan(admin, {
        revision: 0,
        name: "Assignment boundary plan",
        status: "active",
        rounds: [
          {
            id: "eval-assignment-boundary-round",
            name: "Initial review",
            anonymous: false,
            criteria,
          },
        ],
      });
      workspace = await service.getAdminWorkspace(admin);
    }
    const roundId = workspace.plan!.rounds[0]!.id;
    await testEnv.DB.prepare(
      `
      INSERT INTO submissions (
        id, event_id, form_version_id, submitter_person_id, submitter_email,
        public_reference, title, category, format, status, answers_json,
        submitted_snapshot_json, revision, submitted_at, created_at, updated_at
      ) VALUES (
        'eval-assignment-boundary-submission', ?, 'eval-test-form-v1',
        'person-demo-submitter', 'alex.submitter@example.com',
        'SUB-EVAL-ASSIGNMENT-BOUNDARY', 'Assignment boundary proposal',
        'Operations', 'Presentation', 'submitted', '{}', ?, 1,
        unixepoch(), unixepoch(), unixepoch()
      )
    `,
    )
      .bind(admin.eventId, submittedSnapshot())
      .run();
    const auditBefore = await testEnv.DB.prepare(
      `
      SELECT COUNT(*) AS count FROM audit_events
       WHERE event_id = ? AND action = 'evaluation.assignments.created'
    `,
    )
      .bind(admin.eventId)
      .first<{ count: number }>();
    const racingEnv = withBatchRace(testEnv, async () => {
      await new EvaluationService(testEnv).decide(admin, {
        submissionId: "eval-assignment-boundary-submission",
        decision: "rejected",
        rationale: "The released decision wins this write boundary.",
        release: true,
      });
    });

    await expect(
      new EvaluationService(racingEnv).assign(admin, {
        roundId,
        submissionIds: ["eval-assignment-boundary-submission"],
        evaluatorPersonIds: [evaluator.personId],
      }),
    ).rejects.toBeInstanceOf(EvaluationRevisionConflictError);

    const state = await testEnv.DB.prepare(
      `
      SELECT s.status,
             (SELECT COUNT(*) FROM evaluator_assignments assignment
               WHERE assignment.event_id = s.event_id
                 AND assignment.submission_id = s.id) AS assignmentCount,
             (SELECT COUNT(*) FROM audit_events audit
               WHERE audit.event_id = s.event_id
                 AND audit.action = 'evaluation.assignments.created') AS assignmentAuditCount
        FROM submissions s
       WHERE s.id = 'eval-assignment-boundary-submission'
    `,
    ).first<{
      status: string;
      assignmentCount: number;
      assignmentAuditCount: number;
    }>();
    expect(state).toEqual({
      status: "rejected",
      assignmentCount: 0,
      assignmentAuditCount: auditBefore!.count,
    });
  });

  it("does not replace plan rounds when an assignment appears after the precheck", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const token = crypto.randomUUID();
    const eventId = `eval-plan-assignment-event-${token}`;
    const eventViewer = { ...admin, eventId };
    const formId = `eval-plan-assignment-form-${token}`;
    const versionId = `eval-plan-assignment-version-${token}`;
    const submissionId = `eval-plan-assignment-submission-${token}`;
    const roundId = `eval-plan-assignment-round-${token}`;
    const replacementRoundId = `eval-plan-replacement-round-${token}`;
    const assignmentId = `eval-plan-assignment-${token}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at
        ) VALUES (?, ?, 'Plan assignment race', ?, 'UTC', 2_000_000_000, 2_000_086_400)
      `,
      ).bind(eventId, admin.organisationId, `plan-assignment-race-${token}`),
      testEnv.DB.prepare(
        `
        INSERT INTO form_definitions (
          id, event_id, name, kind, status, public_slug, min_speakers,
          max_speakers, access_mode, revision, created_by_person_id,
          created_at, updated_at
        ) VALUES (?, ?, 'Evaluation fixture', 'submission', 'published', ?,
                  1, 4, 'email_verified', 1, ?, unixepoch(), unixepoch())
      `,
      ).bind(formId, eventId, `evaluation-fixture-${token}`, admin.personId),
      testEnv.DB.prepare(
        `
        INSERT INTO form_versions (
          id, event_id, form_id, version_number, schema_json, routing_json,
          settings_snapshot_json, status, revision, published_at,
          created_by_person_id, created_at, updated_at
        ) VALUES (?, ?, ?, 1, '[]', '{}', '{}', 'published', 1,
                  unixepoch(), ?, unixepoch(), unixepoch())
      `,
      ).bind(versionId, eventId, formId, admin.personId),
      testEnv.DB.prepare(
        `
        INSERT INTO submissions (
          id, event_id, form_version_id, submitter_person_id, submitter_email,
          public_reference, title, status, answers_json,
          submitted_snapshot_json, revision, submitted_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'person-demo-submitter', 'alex.submitter@example.com',
                  ?, 'Plan assignment boundary proposal', 'submitted', '{}',
                  ?, 1, unixepoch(), unixepoch(), unixepoch())
      `,
      ).bind(
        submissionId,
        eventId,
        versionId,
        `SUB-${token}`,
        submittedSnapshot({}, versionId),
      ),
    ]);
    const service = new EvaluationService(testEnv);
    await service.savePlan(eventViewer, {
      revision: 0,
      name: "Stable assigned plan",
      status: "active",
      rounds: [
        {
          id: roundId,
          name: "Original round",
          anonymous: false,
          criteria: criteria.map((criterion) => ({
            ...criterion,
            id: `${criterion.id}-${token}-original`,
          })),
        },
      ],
    });
    const racingEnv = withBatchRace(testEnv, async () => {
      await testEnv.DB.prepare(
        `
        INSERT INTO evaluator_assignments (
          id, event_id, round_id, submission_id, evaluator_person_id,
          status, revision, assigned_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          'assigned', 1, unixepoch()
        )
      `,
      )
        .bind(assignmentId, eventId, roundId, submissionId, evaluator.personId)
        .run();
    });

    await expect(
      new EvaluationService(racingEnv).savePlan(eventViewer, {
        revision: 1,
        name: "Unsafe replacement",
        status: "active",
        rounds: [
          {
            id: replacementRoundId,
            name: "Replacement round",
            anonymous: false,
            criteria: criteria.map((criterion) => ({
              ...criterion,
              id: `${criterion.id}-replacement`,
            })),
          },
        ],
      }),
    ).rejects.toThrow(/plan with assignments cannot/i);

    const plan = await testEnv.DB.prepare(
      `
      SELECT name, revision,
             (SELECT COUNT(*) FROM evaluation_rounds current_round
               WHERE current_round.plan_id = evaluation_plans.id
                 AND current_round.id = ?) AS originalRoundCount,
             (SELECT COUNT(*) FROM evaluation_rounds replacement_round
               WHERE replacement_round.plan_id = evaluation_plans.id
                 AND replacement_round.id = ?) AS replacementRoundCount
        FROM evaluation_plans
       WHERE event_id = ? AND status <> 'archived'
    `,
    )
      .bind(roundId, replacementRoundId, eventId)
      .first<{
        name: string;
        revision: number;
        originalRoundCount: number;
        replacementRoundCount: number;
      }>();
    expect(plan).toEqual({
      name: "Stable assigned plan",
      revision: 1,
      originalRoundCount: 1,
      replacementRoundCount: 0,
    });
  });

  it("allows only one current plan when two creators race", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const token = crypto.randomUUID();
    const eventId = `eval-plan-creation-event-${token}`;
    const eventViewer = { ...admin, eventId };
    await testEnv.DB.prepare(
      `
      INSERT INTO events (
        id, organisation_id, name, slug, timezone, starts_at, ends_at
      ) VALUES (?, ?, 'Plan creation race', ?, 'UTC', 2_000_000_000, 2_000_086_400)
    `,
    )
      .bind(eventId, admin.organisationId, `plan-creation-race-${token}`)
      .run();
    const winningRoundId = `eval-winning-round-${token}`;
    const losingRoundId = `eval-losing-round-${token}`;
    const racingEnv = withBatchRace(testEnv, async () => {
      await new EvaluationService(testEnv).savePlan(eventViewer, {
        revision: 0,
        name: "Winning plan",
        status: "active",
        rounds: [
          {
            id: winningRoundId,
            name: "Winning round",
            anonymous: false,
            criteria: criteria.map((criterion) => ({
              ...criterion,
              id: `${criterion.id}-${token}-winner`,
            })),
          },
        ],
      });
    });

    await expect(
      new EvaluationService(racingEnv).savePlan(eventViewer, {
        revision: 0,
        name: "Losing plan",
        status: "active",
        rounds: [
          {
            id: losingRoundId,
            name: "Losing round",
            anonymous: false,
            criteria: criteria.map((criterion) => ({
              ...criterion,
              id: `${criterion.id}-${token}-loser`,
            })),
          },
        ],
      }),
    ).rejects.toBeInstanceOf(EvaluationRevisionConflictError);

    const state = await testEnv.DB.prepare(
      `
      SELECT
        (SELECT COUNT(*) FROM evaluation_plans
          WHERE event_id = ? AND status <> 'archived') AS currentPlanCount,
        (SELECT COUNT(*) FROM evaluation_plans
          WHERE event_id = ? AND name = 'Winning plan') AS winningPlanCount,
        (SELECT COUNT(*) FROM evaluation_rounds
          WHERE event_id = ? AND id = ?) AS winningRoundCount,
        (SELECT COUNT(*) FROM evaluation_rounds
          WHERE event_id = ? AND id = ?) AS losingRoundCount,
        (SELECT COUNT(*) FROM audit_events
          WHERE event_id = ? AND action = 'evaluation.plan.saved') AS auditCount
    `,
    )
      .bind(
        eventId,
        eventId,
        eventId,
        winningRoundId,
        eventId,
        losingRoundId,
        eventId,
      )
      .first<{
        currentPlanCount: number;
        winningPlanCount: number;
        winningRoundCount: number;
        losingRoundCount: number;
        auditCount: number;
      }>();
    expect(state).toEqual({
      currentPlanCount: 1,
      winningPlanCount: 1,
      winningRoundCount: 1,
      losingRoundCount: 0,
      auditCount: 1,
    });
  });

  it("commits either review submission or recusal when they race", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    let adminWorkspace = await service.getAdminWorkspace(admin);
    if (!adminWorkspace.plan?.rounds[0]) {
      await service.savePlan(admin, {
        revision: 0,
        name: "Conflict race plan",
        status: "active",
        rounds: [
          {
            id: "eval-conflict-race-round",
            name: "Initial review",
            anonymous: false,
            criteria,
          },
        ],
      });
      adminWorkspace = await service.getAdminWorkspace(admin);
    }
    await env.DB.prepare(
      `
      INSERT OR IGNORE INTO submissions (
        id, event_id, form_version_id, submitter_person_id, submitter_email,
        public_reference, title, category, format, status, answers_json,
        submitted_snapshot_json, revision, submitted_at, created_at, updated_at
      ) VALUES (
        'eval-conflict-race-submission', ?, 'eval-test-form-v1',
        'person-demo-submitter', 'alex.submitter@example.com',
        'SUB-EVAL-CONFLICT-RACE', 'Conflict race proposal', 'Operations',
        'Presentation', 'submitted', '{}', ?, 1, unixepoch(), unixepoch(), unixepoch()
      )
    `,
    )
      .bind(admin.eventId, submittedSnapshot())
      .run();
    await service.assign(admin, {
      roundId: adminWorkspace.plan!.rounds[0]!.id,
      submissionIds: ["eval-conflict-race-submission"],
      evaluatorPersonIds: [evaluator.personId],
    });
    const queue = await service.getReviewerWorkspace(evaluator);
    const assignmentId = queue.assignments.find(
      (assignment) =>
        assignment.submissionId === "eval-conflict-race-submission",
    )!.id;
    const workspace = await service.getReviewerWorkspace(
      evaluator,
      assignmentId,
    );
    const scores = Object.fromEntries(
      workspace.criteria.map((criterion) => [criterion.id, 4]),
    );

    const attempts = await Promise.allSettled([
      service.saveReview(evaluator, {
        assignmentId: workspace.selected!.id,
        revision: 0,
        scores,
        recommendation: "accept",
        confidence: 4,
        submitterFeedback: "A useful proposal.",
        privateNotes: "",
        intent: "submit",
      }),
      service.declareConflict(evaluator, {
        assignmentId: workspace.selected!.id,
        reason: "A close working relationship prevents an impartial review.",
      }),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);

    const state = await env.DB.prepare(
      `
      SELECT a.status,
             (SELECT status FROM reviews WHERE assignment_id = a.id) AS reviewStatus,
             (SELECT COUNT(*) FROM evaluator_conflicts c
               WHERE c.round_id = a.round_id AND c.submission_id = a.submission_id
                 AND c.evaluator_person_id = a.evaluator_person_id) AS conflictCount
        FROM evaluator_assignments a WHERE a.id = ?
    `,
    )
      .bind(workspace.selected!.id)
      .first<{
        status: string;
        reviewStatus: string | null;
        conflictCount: number;
      }>();
    expect([
      { status: "submitted", reviewStatus: "submitted", conflictCount: 0 },
      { status: "recused", reviewStatus: null, conflictCount: 1 },
    ]).toContainEqual(state);
  });

  it("publishes an accepted decision atomically and records honest notification state", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    const result = await service.decide(admin, {
      submissionId: "eval-test-submission",
      decision: "accepted",
      rationale: "Strong programme fit.",
      release: true,
    });
    expect(result.sessionId).toBeTruthy();
    expect(["queued", "queue_failed"]).toContain(result.notificationStatus);
    const [submission, session, audit] = await Promise.all([
      env.DB.prepare(
        "SELECT status FROM submissions WHERE id = 'eval-test-submission'",
      ).first<{ status: string }>(),
      env.DB.prepare(
        "SELECT source_submission_id AS sourceSubmissionId, status, description FROM sessions WHERE id = ?",
      )
        .bind(result.sessionId)
        .first<{
          sourceSubmissionId: string;
          status: string;
          description: string;
        }>(),
      env.DB.prepare("SELECT action FROM audit_events WHERE entity_id = ?")
        .bind(result.decisionId)
        .first<{ action: string }>(),
    ]);
    expect(submission?.status).toBe("accepted");
    expect(session).toEqual({
      sourceSubmissionId: "eval-test-submission",
      status: "unscheduled",
      description: "A practical description for the public programme.",
    });
    expect(audit?.action).toBe("decision.published");

    await expect(
      service.decide(admin, {
        submissionId: "eval-test-submission",
        decision: "rejected",
        rationale: "A late reversal must use an explicit reopen workflow.",
        release: true,
      }),
    ).rejects.toThrow(/released decisions are final/i);
    await expect(
      service.decide(admin, {
        submissionId: "eval-test-submission",
        decision: "waitlisted",
        rationale: "A draft cannot replace a released decision either.",
        release: false,
      }),
    ).rejects.toThrow(/released decisions are final/i);
    const finalState = await env.DB.prepare(
      `
      SELECT s.status,
             (SELECT COUNT(*) FROM submission_decisions d WHERE d.submission_id = s.id) AS decisionCount,
             (SELECT COUNT(*) FROM sessions candidate WHERE candidate.source_submission_id = s.id) AS sessionCount
        FROM submissions s WHERE s.id = 'eval-test-submission'
    `,
    ).first<{ status: string; decisionCount: number; sessionCount: number }>();
    expect(finalState).toEqual({
      status: "accepted",
      decisionCount: 1,
      sessionCount: 1,
    });
  });

  it("blocks accepted release until every co-speaker has claimed an identity", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `
        INSERT INTO submissions (
          id, event_id, form_version_id, submitter_person_id, submitter_email,
          public_reference, title, category, format, status, answers_json,
          submitted_snapshot_json, revision, submitted_at, created_at, updated_at
        ) VALUES (
          'eval-unclaimed-submission', ?, 'eval-test-form-v1',
          'person-demo-submitter', 'alex.submitter@example.com',
          'SUB-EVAL-UNCLAIMED', 'Proposal with pending co-speaker',
          'Operations', 'Presentation', 'submitted', '{}', ?, 1,
          unixepoch(), unixepoch(), unixepoch()
        )
      `,
      ).bind(admin.eventId, submittedSnapshot()),
      env.DB.prepare(
        `
        INSERT INTO submission_speakers (
          id, event_id, submission_id, person_id, email, display_name, position,
          invitation_status, is_primary, claimed_at, created_at, updated_at
        ) VALUES (
          'eval-unclaimed-primary', ?, 'eval-unclaimed-submission',
          'person-demo-submitter', 'alex.submitter@example.com', 'Alex Morgan',
          0, 'claimed', 1, unixepoch(), unixepoch(), unixepoch()
        )
      `,
      ).bind(admin.eventId),
      env.DB.prepare(
        `
        INSERT INTO submission_speakers (
          id, event_id, submission_id, person_id, email, display_name, position,
          invitation_status, is_primary, created_at, updated_at
        ) VALUES (
          'eval-unclaimed-co-speaker', ?, 'eval-unclaimed-submission', NULL,
          'pending.co-speaker@example.com', 'Pending Co-speaker', 1,
          'pending', 0, unixepoch(), unixepoch()
        )
      `,
      ).bind(admin.eventId),
    ]);

    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await expect(
      service.decide(admin, {
        submissionId: "eval-unclaimed-submission",
        decision: "accepted",
        rationale: "Strong proposal.",
        release: true,
      }),
    ).rejects.toThrow(/claim every co-speaker/i);

    expect(
      await env.DB.prepare(
        `
        SELECT s.status,
               (SELECT COUNT(*) FROM submission_decisions d WHERE d.submission_id = s.id) AS decisionCount,
               (SELECT COUNT(*) FROM sessions candidate WHERE candidate.source_submission_id = s.id) AS sessionCount
          FROM submissions s WHERE s.id = 'eval-unclaimed-submission'
      `,
      ).first(),
    ).toEqual({ status: "submitted", decisionCount: 0, sessionCount: 0 });
  });

  it("cancels active review work when a decision is released", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    let adminWorkspace = await service.getAdminWorkspace(admin);
    if (!adminWorkspace.plan?.rounds[0]) {
      await service.savePlan(admin, {
        revision: 0,
        name: "Decision assignment plan",
        status: "active",
        rounds: [
          {
            id: "eval-decision-assignment-round",
            name: "Initial review",
            anonymous: false,
            criteria,
          },
        ],
      });
      adminWorkspace = await service.getAdminWorkspace(admin);
    }
    await env.DB.prepare(
      `
      INSERT OR IGNORE INTO submissions (
        id, event_id, form_version_id, submitter_person_id, submitter_email,
        public_reference, title, category, format, status, answers_json,
        submitted_snapshot_json, revision, submitted_at, created_at, updated_at
      ) VALUES (
        'eval-active-decision-submission', ?, 'eval-test-form-v1',
        'person-demo-submitter', 'alex.submitter@example.com',
        'SUB-EVAL-ACTIVE-DECISION', 'Active review decision proposal',
        'Operations', 'Presentation', 'submitted', '{}', ?, 1,
        unixepoch(), unixepoch(), unixepoch()
      )
    `,
    )
      .bind(admin.eventId, submittedSnapshot())
      .run();
    await service.assign(admin, {
      roundId: adminWorkspace.plan!.rounds[0]!.id,
      submissionIds: ["eval-active-decision-submission"],
      evaluatorPersonIds: [evaluator.personId],
    });
    const queue = await service.getReviewerWorkspace(evaluator);
    const assignment = queue.assignments.find(
      (candidate) =>
        candidate.submissionId === "eval-active-decision-submission",
    )!;

    await service.decide(admin, {
      submissionId: "eval-active-decision-submission",
      decision: "rejected",
      rationale: "The programme is now final.",
      release: true,
    });
    const stored = await env.DB.prepare(
      `
      SELECT status FROM evaluator_assignments WHERE id = ?
    `,
    )
      .bind(assignment.id)
      .first<{ status: string }>();
    expect(stored?.status).toBe("cancelled");
    await expect(
      service.saveReview(evaluator, {
        assignmentId: assignment.id,
        revision: 0,
        scores: Object.fromEntries(
          criteria.map((criterion) => [criterion.id, 4]),
        ),
        recommendation: null,
        confidence: null,
        submitterFeedback: "",
        privateNotes: "",
        intent: "save",
      }),
    ).rejects.toThrow(/unavailable|already submitted/);
  });

  it("does not expose an event through another organisation", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await expect(
      service.getAdminWorkspace({
        ...admin,
        organisationId: "org-not-authorised",
      }),
    ).rejects.toThrow(/authorised organisation/);
  });

  it("does not list or assign a revoked evaluator", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await env.DB.prepare(
      `
      UPDATE memberships SET revoked_at = unixepoch()
       WHERE event_id = ? AND person_id = ? AND role = 'evaluator'
    `,
    )
      .bind(admin.eventId, evaluator.personId)
      .run();
    let workspace = await service.getAdminWorkspace(admin);
    expect(
      workspace.evaluators.some(
        (candidate) => candidate.id === evaluator.personId,
      ),
    ).toBe(false);
    if (!workspace.plan?.rounds[0]) {
      await service.savePlan(admin, {
        revision: 0,
        name: "Revocation test plan",
        status: "active",
        rounds: [
          {
            id: "eval-revoked-round",
            name: "Initial review",
            anonymous: false,
            criteria,
          },
        ],
      });
      workspace = await service.getAdminWorkspace(admin);
    }
    await env.DB.prepare(
      `
      INSERT OR IGNORE INTO submissions (
        id, event_id, form_version_id, submitter_person_id, submitter_email,
        public_reference, title, category, format, status, answers_json,
        submitted_snapshot_json, revision, submitted_at, created_at, updated_at
      ) VALUES (
        'eval-revoked-submission', ?, 'eval-test-form-v1', 'person-demo-submitter',
        'alex.submitter@example.com', 'SUB-EVAL-REVOKED', 'Revoked evaluator test',
        'Operations', 'Presentation', 'submitted', '{}', ?, 1,
        unixepoch(), unixepoch(), unixepoch()
      )
    `,
    )
      .bind(admin.eventId, submittedSnapshot())
      .run();
    await expect(
      service.assign(admin, {
        roundId: workspace.plan!.rounds[0]!.id,
        submissionIds: ["eval-revoked-submission"],
        evaluatorPersonIds: [evaluator.personId],
      }),
    ).rejects.toThrow(/not authorised/);
  });
});
