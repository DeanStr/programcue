import { env } from "cloudflare:test";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { formSchemaSchema } from "~/modules/submissions/submission-schema";
import { ensureDemoEvaluationData } from "./demo.server";
import { processCommunicationSend } from "../../../workers/queue/communication-send";
import { EvaluationDecisionService } from "./evaluation-decision-service.server";
import {
  EvaluationRevisionConflictError,
  EvaluationService,
  EvaluationStateError,
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

function evaluationEnvironment(base = env as unknown as CloudflareEnvironment) {
  return {
    ...base,
    OPERATIONS_QUEUE: { send: async () => undefined },
  } as unknown as CloudflareEnvironment;
}

async function invitationTokenIdentifier(snapshotJson: string) {
  const body = JSON.parse(snapshotJson).content.body as string;
  const token = new URL(
    body.match(/https?:\/\/\S+/u)?.[0] ?? "",
  ).searchParams.get("token");
  if (!token) throw new Error("The invitation snapshot is missing its token.");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

const criteria = [
  {
    id: "eval-test-relevance",
    name: "Relevance",
    description: "",
    inputType: "scale_5",
    weightPercent: 25,
    required: true,
    position: 0,
  },
  {
    id: "eval-test-originality",
    name: "Originality",
    description: "",
    inputType: "scale_5",
    weightPercent: 20,
    required: true,
    position: 1,
  },
  {
    id: "eval-test-quality",
    name: "Quality",
    description: "",
    inputType: "scale_5",
    weightPercent: 25,
    required: true,
    position: 2,
  },
  {
    id: "eval-test-practical",
    name: "Practical",
    description: "",
    inputType: "scale_5",
    weightPercent: 20,
    required: true,
    position: 3,
  },
  {
    id: "eval-test-expertise",
    name: "Expertise",
    description: "",
    inputType: "scale_5",
    weightPercent: 10,
    required: true,
    position: 4,
  },
] as const;

function submittedSnapshot(
  answers: Record<string, string | string[]> = {},
  formVersionId = "eval-test-form-v1",
  coreReviewVisibility?: "reviewers" | "administrators_only",
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
          reviewVisibility: coreReviewVisibility,
          condition: null,
        },
        {
          id: "category",
          label: "Category",
          type: "short_text",
          required: true,
          help: "",
          options: [],
          reviewVisibility: coreReviewVisibility,
          condition: null,
        },
        {
          id: "format",
          label: "Format",
          type: "short_text",
          required: true,
          help: "",
          options: [],
          reviewVisibility: coreReviewVisibility,
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
    answers: {
      title: "A practical event proposal",
      category: "Operations",
      format: "Presentation",
      ...answers,
    },
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

async function resetEvaluationFixture() {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM submissions WHERE id = 'eval-multi-round-not-advanced'",
    ),
    env.DB.prepare(
      "DELETE FROM sessions WHERE event_id = ? AND source_submission_id = 'eval-test-submission'",
    ).bind(admin.eventId),
    env.DB.prepare(
      "DELETE FROM submission_decisions WHERE event_id = ? AND submission_id = 'eval-test-submission'",
    ).bind(admin.eventId),
    env.DB.prepare("DELETE FROM evaluation_plans WHERE event_id = ?").bind(
      admin.eventId,
    ),
    env.DB.prepare("DELETE FROM evaluation_teams WHERE event_id = ?").bind(
      admin.eventId,
    ),
    env.DB.prepare(
      `UPDATE submissions SET status = 'submitted', title = 'A practical event proposal',
              category = 'Operations', format = 'Presentation', answers_json = ?,
              submitted_snapshot_json = ?, last_operation_id = NULL,
              revision = revision + 1, updated_at = unixepoch()
        WHERE id = 'eval-test-submission' AND event_id = ?`,
    ).bind(
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
      admin.eventId,
    ),
    env.DB.prepare(
      `UPDATE memberships SET revoked_at = NULL, accepted_at = COALESCE(accepted_at, unixepoch())
        WHERE event_id = ? AND person_id = ? AND role = 'evaluator'`,
    ).bind(admin.eventId, evaluator.personId),
  ]);
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
    const demoFormFields = formSchemaSchema.parse(
      JSON.parse(version?.schemaJson ?? "null"),
    ).fields;
    expect(demoFormFields).toHaveLength(6);
    expect(
      demoFormFields.every((field) => field.reviewVisibility === "reviewers"),
    ).toBe(true);
    expect(JSON.parse(version?.routingJson ?? "null")).toEqual({
      categories: {},
      trackIds: {
        "Event Operations": "demo-track-operations",
        "Experience Design": "demo-track-experience",
      },
      trackNames: {
        "demo-track-operations": "Event Operations",
        "demo-track-experience": "Experience Design",
      },
      teamNames: {},
      directSessionDurationMinutes: null,
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
    expect(reviewerWorkspace.selected).toMatchObject({
      id: "demo-evaluation-assignment-1",
      title: "Operational calm under pressure",
      category: "Event Operations",
      format: "Workshop",
    });
    expect(
      reviewerWorkspace.criteria.reduce(
        (sum, criterion) => sum + criterion.weightPercent,
        0,
      ),
    ).toBe(100);
    expect(reviewerWorkspace.submission?.speakerNames).toEqual(["Alex Morgan"]);
    expect(reviewerWorkspace.submission?.answers).toMatchObject({
      title: "Operational calm under pressure",
      category: "Event Operations",
      format: "Workshop",
      session_overview: expect.any(String),
      audience_takeaway: expect.any(String),
      delivery_approach: expect.any(String),
    });
    expect(reviewerWorkspace.review).toBeNull();
    await expect(
      service.getReviewerWorkbench(evaluator),
    ).resolves.toMatchObject({
      kind: "ready",
      eventName: "Future of Events 2025",
      workspace: { selected: { id: "demo-evaluation-assignment-1" } },
    });
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
        `INSERT OR IGNORE INTO form_versions (id, event_id, form_id, version_number, schema_json, routing_json, settings_snapshot_json, status, revision, published_at, created_by_person_id, created_at, updated_at) VALUES ('eval-test-form-v1', ?, 'eval-test-form', 1, '[]', '{"categories":{},"trackIds":{"Operations":"demo-track-operations"},"trackNames":{"demo-track-operations":"Operations"},"teamNames":{},"directSessionDurationMinutes":null,"passwordHash":null}', '{}', 'published', 1, unixepoch(), ?, unixepoch(), unixepoch())`,
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
      env.DB.prepare(
        `INSERT OR IGNORE INTO submission_track_selections (
           submission_id, event_id, track_id, track_name_snapshot, position
         ) VALUES ('eval-test-submission', ?, 'demo-track-operations', 'Operations', 0)`,
      ).bind(admin.eventId),
    ]);
  });

  describe("decision and accepted-speaker workflows", () => {
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
            confirmedWithoutReview: true,
            sessionDurationMinutes: 60,
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
              confirmedWithoutReview: true,
              sessionDurationMinutes: 60,
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
            ...evaluationEnvironment(),
            DB: boundaryDb,
          }).decide(committeeChair, {
            submissionId: "eval-test-submission",
            decision: "accepted",
            rationale: "The authority must still exist at the write boundary.",
            release: true,
            confirmedWithoutReview: true,
            sessionDurationMinutes: 60,
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

    it("does not let a committee chair grant their own final-decision authority", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );

      await expect(
        service.savePlan(committeeChair, {
          revision: 0,
          name: "Self-granted chair authority",
          status: "active",
          decisionRole: "committee_chair",
          rounds: [
            {
              id: "eval-chair-self-grant-round",
              name: "Initial review",
              anonymous: false,
              criteria,
            },
          ],
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        env.DB.prepare(
          "SELECT COUNT(*) AS count FROM evaluation_plans WHERE event_id = ?",
        )
          .bind(admin.eventId)
          .first(),
      ).resolves.toEqual({ count: 0 });

      const planId = await service.savePlan(committeeChair, {
        revision: 0,
        name: "Administrator-owned decision authority",
        status: "active",
        decisionRole: "administrator",
        rounds: [
          {
            id: "eval-chair-admin-authority-round",
            name: "Initial review",
            anonymous: false,
            criteria,
          },
        ],
      });
      await expect(
        env.DB.prepare(
          "SELECT decision_role AS decisionRole FROM evaluation_plans WHERE id = ?",
        )
          .bind(planId)
          .first(),
      ).resolves.toEqual({ decisionRole: "administrator" });
      await env.DB.prepare("DELETE FROM evaluation_plans WHERE id = ?")
        .bind(planId)
        .run();
    });
  });

  describe("reviewer workflows", () => {
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
        targetType: "submission",
        targetIds: ["eval-test-submission"],
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
  });

  describe("assignment workflows", () => {
    it("assigns sessions from an immutable snapshot and supports review, reopen and recusal", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      await env.DB.batch([
        env.DB.prepare("DELETE FROM sessions WHERE id IN (?, ?)").bind(
          "eval-session-target",
          "eval-session-conflict-target",
        ),
        env.DB.prepare(
          `INSERT INTO sessions (
           id, event_id, title, slug, description, format, duration_minutes,
           status, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'workshop', 75, 'unscheduled', 1,
                   unixepoch(), unixepoch())`,
        ).bind(
          "eval-session-target",
          admin.eventId,
          "Immutable session source",
          "immutable-session-source",
          "The source description captured for reviewers.",
        ),
        env.DB.prepare(
          `INSERT INTO sessions (
           id, event_id, title, slug, description, format, duration_minutes,
           status, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'panel', 45, 'unscheduled', 1,
                   unixepoch(), unixepoch())`,
        ).bind(
          "eval-session-conflict-target",
          admin.eventId,
          "Conflict session",
          "conflict-session",
          "A second direct session.",
        ),
        env.DB.prepare(
          `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label, visibility
         ) VALUES (?, ?, 'person-demo-submitter', 0, 'Facilitator', 'public')`,
        ).bind("eval-session-target", admin.eventId),
      ]);
      try {
        const sessionOrder = (await service.getAdminWorkspace(admin)).sessions
          .filter((session) =>
            ["eval-session-target", "eval-session-conflict-target"].includes(
              session.id,
            ),
          )
          .map((session) => session.id);
        expect(sessionOrder).toEqual([
          "eval-session-conflict-target",
          "eval-session-target",
        ]);
        await service.savePlan(admin, {
          revision: 0,
          name: "Direct session review plan",
          status: "active",
          rounds: [
            {
              id: "eval-session-round",
              name: "Session quality review",
              anonymous: false,
              criteria,
            },
          ],
        });
        const assigned = await service.assign(admin, {
          roundId: "eval-session-round",
          targetType: "session",
          targetIds: ["eval-session-target", "eval-session-conflict-target"],
          evaluatorPersonIds: [evaluator.personId],
        });
        expect(assigned.createdAssignmentCount).toBe(2);
        await env.DB.prepare(
          `UPDATE sessions
            SET title = 'Changed after assignment',
                description = 'This later edit is not reviewer evidence.',
                duration_minutes = 30, revision = revision + 1
          WHERE id = ? AND event_id = ?`,
        )
          .bind("eval-session-target", admin.eventId)
          .run();

        const queue = await service.getReviewerWorkspace(evaluator);
        const targetAssignment = queue.assignments.find(
          (assignment) => assignment.sessionId === "eval-session-target",
        );
        expect(targetAssignment).toMatchObject({
          targetType: "session",
          targetId: "eval-session-target",
          title: "Immutable session source",
          format: "workshop",
        });
        const workspace = await service.getReviewerWorkspace(
          evaluator,
          targetAssignment!.id,
        );
        expect(workspace.submission).toMatchObject({
          sourceType: "session",
          id: "eval-session-target",
          title: "Immutable session source",
          speakerNames: ["Alex Morgan"],
          answers: {
            description: "The source description captured for reviewers.",
            durationMinutes: 75,
          },
        });
        expect(JSON.stringify(workspace.submission)).not.toContain(
          "This later edit is not reviewer evidence.",
        );
        const scores = Object.fromEntries(
          criteria.map((criterion) => [criterion.id, 4]),
        );
        const submitted = await service.saveReview(evaluator, {
          assignmentId: targetAssignment!.id,
          revision: 0,
          scores,
          recommendation: "accept",
          confidence: 4,
          submitterFeedback: "Strong session.",
          privateNotes: "Ready.",
          intent: "submit",
        });
        expect(submitted.weightedScore).toBe(4);
        expect(
          await env.DB.prepare(
            "SELECT status FROM sessions WHERE id = 'eval-session-target'",
          ).first(),
        ).toEqual({ status: "unscheduled" });

        const reopened = await service.reopenReview(admin, {
          assignmentId: targetAssignment!.id,
          reason: "The evaluator needs to correct a material factual error.",
          confirmed: true,
        });
        expect(reopened.revision).toBe(2);
        await service.saveReview(evaluator, {
          assignmentId: targetAssignment!.id,
          revision: reopened.revision,
          scores,
          recommendation: "accept",
          confidence: 5,
          submitterFeedback: "Corrected session review.",
          privateNotes: "Ready.",
          intent: "submit",
        });

        const conflictAssignment = queue.assignments.find(
          (assignment) =>
            assignment.sessionId === "eval-session-conflict-target",
        );
        await service.declareConflict(evaluator, {
          assignmentId: conflictAssignment!.id,
          reason: "I have a close working relationship with the session owner.",
        });
        expect(
          await env.DB.prepare(
            `SELECT submission_id AS submissionId, session_id AS sessionId,
                  status
             FROM evaluator_conflicts
            WHERE round_id = ? AND session_id = ?`,
          )
            .bind("eval-session-round", "eval-session-conflict-target")
            .first(),
        ).toEqual({
          submissionId: null,
          sessionId: "eval-session-conflict-target",
          status: "recused",
        });
      } finally {
        await env.DB.prepare(
          "DELETE FROM evaluation_plans WHERE id = 'eval-session-round' OR name = 'Direct session review plan'",
        ).run();
        await env.DB.prepare("DELETE FROM sessions WHERE id IN (?, ?)")
          .bind("eval-session-target", "eval-session-conflict-target")
          .run();
      }
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
      await env.DB.prepare(
        `INSERT OR IGNORE INTO submission_track_selections (
         submission_id, event_id, track_id, track_name_snapshot, position
       ) VALUES (
         'eval-explicit-selection-submission', ?,
         'demo-track-operations', 'Operations', 0
       )`,
      )
        .bind(admin.eventId)
        .run();
      await service.assign(admin, {
        roundId,
        targetType: "submission",
        targetIds: ["eval-explicit-selection-submission"],
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
        await expect(
          service.getReviewerWorkbench(
            evaluator,
            "eval-recused-access-assignment",
          ),
        ).resolves.toEqual({ kind: "selection_recused" });
      } finally {
        await env.DB.prepare(
          "DELETE FROM evaluation_plans WHERE id = 'eval-recused-access-plan'",
        ).run();
      }
    });
  });

  describe("reviewer workflows", () => {
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
        targetType: "submission",
        targetIds: ["eval-invalid-snapshot-submission"],
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
      await env.DB.prepare(
        "DELETE FROM submissions WHERE id = 'eval-invalid-snapshot-submission'",
      ).run();
    });
  });

  describe("decision and accepted-speaker workflows", () => {
    it("does not create an assignment when a decision wins after validation", async () => {
      const testEnv = evaluationEnvironment();
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
      await testEnv.DB.prepare(
        `
      INSERT INTO submission_track_selections (
        submission_id, event_id, track_id, track_name_snapshot, position
      ) VALUES (
        'eval-assignment-boundary-submission', ?, 'demo-track-operations',
        'Operations', 0
      )
    `,
      )
        .bind(admin.eventId)
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
          confirmedWithoutReview: true,
        });
      });

      await expect(
        new EvaluationService(racingEnv).assign(admin, {
          roundId,
          targetType: "submission",
          targetIds: ["eval-assignment-boundary-submission"],
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
  });

  describe("round workflows", () => {
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
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (?, ?, 'Plan assignment race', ?, 'UTC', 2_000_000_000, 2_000_086_400,
                  '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')
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
          .bind(
            assignmentId,
            eventId,
            roundId,
            submissionId,
            evaluator.personId,
          )
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
  });

  describe("additional workflow coverage", () => {
    it("allows only one current plan when two creators race", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      const token = crypto.randomUUID();
      const eventId = `eval-plan-creation-event-${token}`;
      const eventViewer = { ...admin, eventId };
      await testEnv.DB.prepare(
        `
      INSERT INTO events (
        id, organisation_id, name, slug, timezone, starts_at, ends_at,
        file_policy_json
      ) VALUES (?, ?, 'Plan creation race', ?, 'UTC', 2_000_000_000, 2_000_086_400,
                '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')
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
  });

  describe("reviewer workflows", () => {
    it("commits either review submission or recusal when they race", async () => {
      const service = new EvaluationService(evaluationEnvironment());
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
      await env.DB.prepare(
        `INSERT OR IGNORE INTO submission_track_selections (
         submission_id, event_id, track_id, track_name_snapshot, position
       ) VALUES (
         'eval-conflict-race-submission', ?,
         'demo-track-operations', 'Operations', 0
       )`,
      )
        .bind(admin.eventId)
        .run();
      await service.assign(admin, {
        roundId: adminWorkspace.plan!.rounds[0]!.id,
        targetType: "submission",
        targetIds: ["eval-conflict-race-submission"],
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
  });

  describe("decision and accepted-speaker workflows", () => {
    it("rejects accepted-session release when submitted track identity is missing", async () => {
      await resetEvaluationFixture();
      await env.DB.prepare(
        `DELETE FROM submission_track_selections
        WHERE submission_id = 'eval-test-submission' AND event_id = ?`,
      )
        .bind(admin.eventId)
        .run();

      await expect(
        new EvaluationService(evaluationEnvironment()).decide(admin, {
          submissionId: "eval-test-submission",
          decision: "accepted",
          rationale: "A trackless acceptance must not be released.",
          release: true,
          confirmedWithoutReview: true,
          sessionDurationMinutes: 60,
        }),
      ).rejects.toThrow(/must retain at least one submitted event track/i);
      await expect(
        env.DB.prepare(
          `SELECT status,
                (SELECT COUNT(*) FROM submission_decisions
                  WHERE submission_id = submissions.id) AS decisionCount,
                (SELECT COUNT(*) FROM sessions
                  WHERE source_submission_id = submissions.id) AS sessionCount
           FROM submissions WHERE id = 'eval-test-submission' AND event_id = ?`,
        )
          .bind(admin.eventId)
          .first(),
      ).resolves.toEqual({
        status: "submitted",
        decisionCount: 0,
        sessionCount: 0,
      });
    });

    it("publishes an accepted decision atomically and records honest notification state", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(evaluationEnvironment());
      await env.DB.prepare(
        `DELETE FROM memberships
        WHERE event_id = ? AND person_id = 'person-demo-submitter'
          AND role = 'speaker'`,
      )
        .bind(admin.eventId)
        .run();
      await env.DB.prepare(
        `UPDATE submissions SET title = 'Changed live title', format = 'Changed live format'
        WHERE id = 'eval-test-submission' AND event_id = ?`,
      )
        .bind(admin.eventId)
        .run();
      await expect(
        service.decide(admin, {
          submissionId: "eval-test-submission",
          decision: "accepted",
          rationale: "Strong programme fit.",
          release: true,
        }),
      ).rejects.toThrow(/confirm the review-evidence override/i);
      const result = await service.decide(admin, {
        submissionId: "eval-test-submission",
        decision: "accepted",
        rationale: "Strong programme fit.",
        release: true,
        confirmedWithoutReview: true,
        sessionDurationMinutes: 60,
      });
      expect(result.sessionId).toBeTruthy();
      expect(result.notificationStatus).toBe("queued");
      expect(result.speakerInvitationStatus).toBe("demo_not_sent");
      expect(result.speakerInvitationCount).toBe(1);
      const [submission, session, audit, speakerMembership] = await Promise.all(
        [
          env.DB.prepare(
            "SELECT status FROM submissions WHERE id = 'eval-test-submission'",
          ).first<{ status: string }>(),
          env.DB.prepare(
            "SELECT source_submission_id AS sourceSubmissionId, title, format, duration_minutes AS durationMinutes, status, description FROM sessions WHERE id = ?",
          )
            .bind(result.sessionId)
            .first<{
              sourceSubmissionId: string;
              title: string;
              format: string;
              durationMinutes: number;
              status: string;
              description: string;
            }>(),
          env.DB.prepare("SELECT action FROM audit_events WHERE entity_id = ?")
            .bind(result.decisionId)
            .first<{ action: string }>(),
          env.DB.prepare(
            `SELECT membership.id, membership.accepted_at AS acceptedAt,
                membership.revoked_at AS revokedAt,
                membership.invitation_expires_at AS expiresAt,
                (SELECT COUNT(*) FROM audit_events audit
                  WHERE audit.entity_id = membership.id
                    AND audit.action = 'membership.speaker.invited') AS auditCount
           FROM memberships membership
          WHERE membership.event_id = ?
            AND membership.person_id = 'person-demo-submitter'
            AND membership.role = 'speaker'`,
          )
            .bind(admin.eventId)
            .first<{
              id: string;
              acceptedAt: number | null;
              revokedAt: number | null;
              expiresAt: number;
              auditCount: number;
            }>(),
        ],
      );
      expect(submission?.status).toBe("accepted");
      expect(session).toEqual({
        sourceSubmissionId: "eval-test-submission",
        title: "A practical event proposal",
        format: "presentation",
        durationMinutes: 60,
        status: "unscheduled",
        description: "A practical description for the public programme.",
      });
      expect(audit?.action).toBe("decision.published");
      expect(speakerMembership).toMatchObject({
        id: expect.any(String),
        acceptedAt: null,
        revokedAt: null,
        auditCount: 1,
      });
      expect(speakerMembership!.expiresAt).toBeGreaterThan(
        Math.floor(Date.now() / 1_000),
      );

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
      ).first<{
        status: string;
        decisionCount: number;
        sessionCount: number;
      }>();
      expect(finalState).toEqual({
        status: "accepted",
        decisionCount: 1,
        sessionCount: 1,
      });
    });

    it("snapshots selected applicant-facing reviewer feedback for the decision email", async () => {
      await resetEvaluationFixture();
      const token = crypto.randomUUID();
      const planId = `feedback-plan-${token}`;
      const roundId = `feedback-round-${token}`;
      const assignmentId = `feedback-assignment-${token}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO evaluation_plans (id, event_id, name, status)
         VALUES (?, ?, 'Decision feedback plan', 'active')`,
        ).bind(planId, admin.eventId),
        env.DB.prepare(
          `INSERT INTO evaluation_rounds (
           id, event_id, plan_id, round_number, name, status
         ) VALUES (?, ?, ?, 1, 'Completed review round', 'active')`,
        ).bind(roundId, admin.eventId, planId),
        env.DB.prepare(
          `INSERT INTO evaluator_assignments (
           id, event_id, round_id, submission_id, evaluator_person_id,
           status, assigned_at, submitted_at
         ) VALUES (?, ?, ?, 'eval-test-submission', 'person-demo-evaluator',
                   'submitted', unixepoch(), unixepoch())`,
        ).bind(assignmentId, admin.eventId, roundId),
        env.DB.prepare(
          `INSERT INTO reviews (
           id, event_id, assignment_id, status, scores_json,
           recommendation, confidence, submitter_feedback, submitted_at
         ) VALUES (?, ?, ?, 'submitted', '{}', 'minor_changes', 4, ?, unixepoch())`,
        ).bind(
          `feedback-review-${token}`,
          admin.eventId,
          assignmentId,
          "Clarify the intended experience level in the final description.",
        ),
      ]);
      const result = await new EvaluationService(
        evaluationEnvironment(),
      ).decide(admin, {
        submissionId: "eval-test-submission",
        decision: "rejected",
        rationale: "The programme is already full in this area.",
        includeReviewerFeedback: true,
        release: true,
      });
      await expect(
        env.DB.prepare(
          `SELECT rationale,
                notification_feedback_json AS notificationFeedbackJson
           FROM submission_decisions WHERE id = ? AND event_id = ?`,
        )
          .bind(result.decisionId, admin.eventId)
          .first(),
      ).resolves.toEqual({
        rationale: "The programme is already full in this area.",
        notificationFeedbackJson: JSON.stringify([
          "Clarify the intended experience level in the final description.",
        ]),
      });
    });

    it("persists accepted-speaker sign-in intent before Queue delivery and recovers it exactly", async () => {
      await resetEvaluationFixture();
      await env.DB.prepare(
        `DELETE FROM memberships
        WHERE event_id = ? AND person_id = 'person-demo-submitter'
          AND role = 'speaker'`,
      )
        .bind(admin.eventId)
        .run();
      await env.DB.prepare(
        `INSERT INTO sender_profiles (
         id, event_id, name, from_name, from_email, provider, status,
         created_at, updated_at
       ) VALUES (?, ?, 'Accepted speaker invitations', 'Program Cue',
                 'speakers@example.com', 'resend', 'verified',
                 unixepoch(), unixepoch())`,
      )
        .bind(`accepted-speaker-sender-${crypto.randomUUID()}`, admin.eventId)
        .run();
      const queued: unknown[] = [];
      const productionLike = {
        ...(env as unknown as CloudflareEnvironment),
        DEMO_MODE: "false",
        APP_ENV: "production",
        BETTER_AUTH_URL: "https://programcue.test",
        OPERATIONS_QUEUE: {
          send: async (message: unknown) => {
            queued.push(message);
          },
        },
      } as unknown as CloudflareEnvironment;
      const commandId = `accepted-invitation-${crypto.randomUUID()}`;
      const input = {
        submissionId: "eval-test-submission",
        decision: "accepted" as const,
        rationale: "Strong programme fit.",
        release: true,
        confirmedWithoutReview: true,
        sessionDurationMinutes: 60,
      };
      const service = new EvaluationDecisionService(productionLike);
      const result = await service.decide(admin, input, commandId);
      expect(result.speakerInvitationStatus).toBe("queued");
      expect(result.speakerInvitationCount).toBe(1);
      expect(queued).toEqual([
        expect.objectContaining({ type: "decision.notification" }),
        expect.objectContaining({ type: "communication.send" }),
      ]);
      const intent = await env.DB.prepare(
        `SELECT operation.status, communication.content_snapshot_json AS snapshot,
              delivery.source_id AS membershipId,
              verification.identifier, verification.value
         FROM communications communication
         JOIN operation_jobs operation ON operation.id = communication.operation_id
         JOIN communication_deliveries delivery
           ON delivery.communication_id = communication.id
         JOIN verification_tokens verification
           ON verification.id LIKE 'asi-v:%'
        WHERE communication.event_id = ?
          AND json_extract(communication.audience_json, '$.decisionId') = ?
        ORDER BY verification.created_at DESC LIMIT 1`,
      )
        .bind(admin.eventId, commandId)
        .first<{
          status: string;
          snapshot: string;
          membershipId: string;
          identifier: string;
          value: string;
        }>();
      expect(intent).not.toBeNull();
      expect(intent?.status).toBe("queued");
      expect(intent?.membershipId).toBeTruthy();
      const invitationSnapshot = JSON.parse(intent!.snapshot) as {
        content: { buttonUrl: string };
      };
      expect(invitationSnapshot).toMatchObject({
        category: "accepted_speaker_invitation",
        event: { brandAccent: "#4f46e5" },
      });
      const invitationUrl = new URL(invitationSnapshot.content.buttonUrl);
      const callbackUrl = new URL(
        invitationUrl.searchParams.get("callbackURL")!,
        "https://programcue.test",
      );
      expect(callbackUrl.pathname).toBe("/events/select");
      expect(callbackUrl.searchParams.get("eventId")).toBe(admin.eventId);
      expect(callbackUrl.searchParams.get("returnTo")).toBe(
        "/speaker/dashboard",
      );
      expect(intent?.identifier).not.toContain("person-demo-submitter");
      expect(JSON.parse(intent!.value)).toEqual({
        email: "alex.submitter@example.com",
      });

      const replay = await service.decide(admin, input, commandId);
      expect(replay.speakerInvitationStatus).toBe("queued");
      expect(replay.speakerInvitationCount).toBe(1);
      expect(queued).toHaveLength(2);

      await env.DB.prepare(
        `UPDATE memberships SET revoked_at = unixepoch()
        WHERE id = ? AND event_id = ?`,
      )
        .bind(intent!.membershipId, admin.eventId)
        .run();
      let providerCalls = 0;
      await processCommunicationSend(queued[1], productionLike, {
        email: {
          name: "resend",
          async send() {
            providerCalls += 1;
            return { provider: "resend", messageId: "should-not-send" };
          },
        },
      });
      expect(providerCalls).toBe(0);
      await expect(
        env.DB.prepare(
          `SELECT status, failure_code AS failureCode
           FROM communication_deliveries
          WHERE communication_id = (
            SELECT id FROM communications
             WHERE event_id = ?
               AND json_extract(audience_json, '$.decisionId') = ?
          )`,
        )
          .bind(admin.eventId, commandId)
          .first(),
      ).resolves.toEqual({
        status: "suppressed",
        failureCode: "invitation_unavailable",
      });
    });

    it("rotates and durably requeues an expired accepted-speaker invitation", async () => {
      await resetEvaluationFixture();
      await env.DB.prepare(
        `DELETE FROM memberships
        WHERE event_id = ? AND person_id = 'person-demo-submitter'
          AND role = 'speaker'`,
      )
        .bind(admin.eventId)
        .run();
      await env.DB.prepare(
        `INSERT INTO sender_profiles (
         id, event_id, name, from_name, from_email, provider, status,
         created_at, updated_at
       ) VALUES (?, ?, 'Accepted speaker resend', 'Program Cue',
                 'speakers@example.com', 'resend', 'verified',
                 unixepoch(), unixepoch())`,
      )
        .bind(`accepted-speaker-resend-${crypto.randomUUID()}`, admin.eventId)
        .run();
      const queued: unknown[] = [];
      const productionLike = {
        ...(env as unknown as CloudflareEnvironment),
        DEMO_MODE: "false",
        APP_ENV: "production",
        BETTER_AUTH_URL: "https://programcue.test",
        OPERATIONS_QUEUE: {
          send: async (message: unknown) => {
            queued.push(message);
          },
        },
      } as unknown as CloudflareEnvironment;
      const commandId = `accepted-resend-${crypto.randomUUID()}`;
      const released = await new EvaluationDecisionService(
        productionLike,
      ).decide(
        admin,
        {
          submissionId: "eval-test-submission",
          decision: "accepted",
          rationale: "Strong programme fit.",
          release: true,
          confirmedWithoutReview: true,
          sessionDurationMinutes: 60,
        },
        commandId,
      );
      expect(released.sessionId).toBeTruthy();
      expect(queued).toHaveLength(2);
      const original = await env.DB.prepare(
        `SELECT membership.id AS membershipId,
              membership.invitation_expires_at AS expiresAt,
              communication.id AS communicationId,
              communication.content_snapshot_json AS snapshotJson
         FROM memberships membership
         JOIN communications communication
           ON communication.event_id = membership.event_id
          AND json_extract(communication.audience_json, '$.decisionId') = ?
          AND json_extract(communication.audience_json, '$.membershipId') = membership.id
        WHERE membership.event_id = ? AND membership.person_id = 'person-demo-submitter'
          AND membership.role = 'speaker'`,
      )
        .bind(commandId, admin.eventId)
        .first<{
          membershipId: string;
          expiresAt: number;
          communicationId: string;
          snapshotJson: string;
        }>();
      expect(original).not.toBeNull();
      const originalIdentifier = await invitationTokenIdentifier(
        original!.snapshotJson,
      );
      const expiredAt = Math.floor(Date.now() / 1_000) - 60;
      await env.DB.prepare(
        `UPDATE memberships SET invitation_expires_at = ?
        WHERE id = ? AND event_id = ?`,
      )
        .bind(expiredAt, original!.membershipId, admin.eventId)
        .run();

      await expect(
        new EvaluationService({
          ...productionLike,
          OPERATIONS_QUEUE: undefined,
        } as unknown as CloudflareEnvironment).resendAcceptedSpeakerInvitation(
          admin,
          {
            decisionId: commandId,
            membershipId: original!.membershipId,
            expectedExpiresAt: expiredAt,
          },
        ),
      ).rejects.toThrow("Required OPERATIONS_QUEUE binding is unavailable");
      await expect(
        env.DB.prepare(
          `SELECT invitation_expires_at AS expiresAt
           FROM memberships WHERE id = ? AND event_id = ?`,
        )
          .bind(original!.membershipId, admin.eventId)
          .first(),
      ).resolves.toEqual({ expiresAt: expiredAt });

      const result = await new EvaluationService(
        productionLike,
      ).resendAcceptedSpeakerInvitation(admin, {
        decisionId: commandId,
        membershipId: original!.membershipId,
        expectedExpiresAt: expiredAt,
      });
      expect(result).toMatchObject({
        status: "queued",
        replayed: false,
        operationId: expect.stringMatching(/^asi-ro:/u),
      });
      expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1_000));
      expect(queued).toHaveLength(3);
      expect(queued[2]).toMatchObject({
        type: "communication.send",
        operationId: result.operationId,
        communicationId: result.communicationId,
      });

      const renewed = await env.DB.prepare(
        `SELECT membership.invitation_expires_at AS expiresAt,
              membership.last_operation_id AS operationId,
              previous_communication.status AS previousCommunicationStatus,
              previous_delivery.status AS previousDeliveryStatus,
              previous_operation.status AS previousOperationStatus,
              renewal_audit.action AS auditAction
         FROM memberships membership
         JOIN communications previous_communication
           ON previous_communication.id = ?
          AND previous_communication.event_id = membership.event_id
         JOIN communication_deliveries previous_delivery
           ON previous_delivery.communication_id = previous_communication.id
         JOIN operation_jobs previous_operation
           ON previous_operation.id = previous_communication.operation_id
         JOIN audit_events renewal_audit
           ON renewal_audit.correlation_id = membership.last_operation_id
          AND renewal_audit.action = 'membership.speaker.invitation.renewed'
        WHERE membership.id = ? AND membership.event_id = ?`,
      )
        .bind(original!.communicationId, original!.membershipId, admin.eventId)
        .first<{
          expiresAt: number;
          operationId: string;
          previousCommunicationStatus: string;
          previousDeliveryStatus: string;
          previousOperationStatus: string;
          auditAction: string;
        }>();
      expect(renewed).toMatchObject({
        expiresAt: result.expiresAt,
        operationId: result.operationId,
        previousCommunicationStatus: "cancelled",
        previousDeliveryStatus: "cancelled",
        previousOperationStatus: "cancelled",
        auditAction: "membership.speaker.invitation.renewed",
      });
      const replacement = await env.DB.prepare(
        `SELECT communication.content_snapshot_json AS snapshotJson
         FROM communications communication
        WHERE communication.id = ? AND communication.event_id = ?`,
      )
        .bind(result.communicationId, admin.eventId)
        .first<{ snapshotJson: string }>();
      const replacementIdentifier = await invitationTokenIdentifier(
        replacement!.snapshotJson,
      );
      expect(replacementIdentifier).not.toBe(originalIdentifier);
      await expect(
        env.DB.prepare(
          `SELECT COUNT(*) AS count FROM verification_tokens
          WHERE identifier = ? AND expires_at = ?`,
        )
          .bind(replacementIdentifier, result.expiresAt)
          .first(),
      ).resolves.toEqual({ count: 1 });

      const replay = await new EvaluationService(
        productionLike,
      ).resendAcceptedSpeakerInvitation(admin, {
        decisionId: commandId,
        membershipId: original!.membershipId,
        expectedExpiresAt: expiredAt,
      });
      expect(replay).toMatchObject({
        operationId: result.operationId,
        communicationId: result.communicationId,
        status: "queued",
        replayed: true,
      });
      expect(queued).toHaveLength(3);
    });

    it("requires the operations Queue before mutating a released decision", async () => {
      await resetEvaluationFixture();
      const unavailableEnvironment = {
        ...(env as unknown as CloudflareEnvironment),
        OPERATIONS_QUEUE: undefined,
      } as unknown as CloudflareEnvironment;

      await expect(
        new EvaluationService(unavailableEnvironment).decide(admin, {
          submissionId: "eval-test-submission",
          decision: "rejected",
          rationale: "A released decision requires notification dispatch.",
          release: true,
          confirmedWithoutReview: true,
        }),
      ).rejects.toThrow("Required OPERATIONS_QUEUE binding is unavailable");
      await expect(
        env.DB.prepare(
          `SELECT status,
                (SELECT COUNT(*) FROM submission_decisions decision
                  WHERE decision.submission_id = submissions.id) AS decisionCount
           FROM submissions WHERE id = 'eval-test-submission'`,
        ).first(),
      ).resolves.toEqual({ status: "submitted", decisionCount: 0 });
    });

    it("atomically materialises the configured acceptance task graph for every supported scope", async () => {
      await resetEvaluationFixture();
      const token = crypto.randomUUID();
      const prerequisiteTemplateId = `acceptance-prerequisite-${token}`;
      const speakerTemplateId = `acceptance-speaker-${token}`;
      const sessionTemplateId = `acceptance-session-${token}`;
      const eventTemplateId = `acceptance-event-${token}`;
      const existingEventTaskId = `acceptance-event-task-${token}`;
      const fixedDueAt = Math.floor(Date.now() / 1_000) + 86_400;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO task_templates (
           id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,
           auto_assign_on_acceptance,status
         ) VALUES (?,?,'Acceptance prerequisite','speaker','checklist','high',
                   'checkbox','none',0,'active')`,
        ).bind(prerequisiteTemplateId, admin.eventId),
        env.DB.prepare(
          `INSERT INTO task_templates (
           id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,
           auto_assign_on_acceptance,status
         ) VALUES (?,?,'Acceptance speaker task','speaker','checklist','high',
                   'checkbox','none',1,'active')`,
        ).bind(speakerTemplateId, admin.eventId),
        env.DB.prepare(
          `INSERT INTO task_template_dependencies (
           template_id,depends_on_template_id,created_at
         ) VALUES (?,?,unixepoch())`,
        ).bind(speakerTemplateId, prerequisiteTemplateId),
        env.DB.prepare(
          `INSERT INTO task_templates (
           id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,
           due_offset_minutes,auto_assign_on_acceptance,status
         ) VALUES (?,?,'Acceptance session task','session','administrator_only',
                   'medium','none','acceptance',2880,1,'active')`,
        ).bind(sessionTemplateId, admin.eventId),
        env.DB.prepare(
          `INSERT INTO task_templates (
           id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,
           fixed_due_at,auto_assign_on_acceptance,status
         ) VALUES (?,?,'Acceptance event task','event','administrator_only',
                   'low','none','fixed',?,1,'active')`,
        ).bind(eventTemplateId, admin.eventId, fixedDueAt),
        env.DB.prepare(
          `INSERT INTO task_instances (
           id,event_id,template_id,target_type,target_id,owner_person_id,title,
           task_type,impact,status,readiness_state,readiness_percent,revision,
           due_at,created_at,updated_at
         ) VALUES (?,?,?,'event',?,NULL,'Existing event task',
                   'administrator_only','low','completed','on_track',100,1,?,
                   unixepoch(),unixepoch())`,
        ).bind(
          existingEventTaskId,
          admin.eventId,
          eventTemplateId,
          admin.eventId,
          fixedDueAt,
        ),
      ]);

      const result = await new EvaluationService(
        evaluationEnvironment(),
      ).decide(admin, {
        submissionId: "eval-test-submission",
        decision: "accepted",
        rationale: "Create the configured onboarding plan.",
        release: true,
        confirmedWithoutReview: true,
        sessionDurationMinutes: 60,
      });

      const tasks = await env.DB.prepare(
        `SELECT id,template_id AS templateId,target_type AS targetType,
              target_id AS targetId,owner_person_id AS ownerPersonId,status,
              last_operation_id AS lastOperationId,due_at AS dueAt
         FROM task_instances
        WHERE template_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        ORDER BY template_id`,
      )
        .bind(
          JSON.stringify([
            prerequisiteTemplateId,
            speakerTemplateId,
            sessionTemplateId,
            eventTemplateId,
          ]),
        )
        .all<{
          id: string;
          templateId: string;
          targetType: string;
          targetId: string;
          ownerPersonId: string | null;
          status: string;
          lastOperationId: string | null;
          dueAt: number | null;
        }>();
      expect(tasks.results).toHaveLength(4);
      expect(
        tasks.results.find(
          (task) => task.templateId === prerequisiteTemplateId,
        ),
      ).toMatchObject({
        targetType: "speaker",
        targetId: "person-demo-submitter",
        ownerPersonId: "person-demo-submitter",
        status: "not_started",
        lastOperationId: result.decisionId,
      });
      expect(
        tasks.results.find((task) => task.templateId === speakerTemplateId),
      ).toMatchObject({
        targetType: "speaker",
        targetId: "person-demo-submitter",
        ownerPersonId: "person-demo-submitter",
        status: "blocked",
        lastOperationId: result.decisionId,
      });
      const sessionTask = tasks.results.find(
        (task) => task.templateId === sessionTemplateId,
      );
      expect(sessionTask).toMatchObject({
        targetType: "session",
        targetId: result.sessionId,
        ownerPersonId: null,
        status: "not_started",
        lastOperationId: result.decisionId,
      });
      expect(sessionTask!.dueAt).toBeGreaterThanOrEqual(
        Math.floor(Date.now() / 1_000) + 172_790,
      );
      expect(
        tasks.results.find((task) => task.templateId === eventTemplateId),
      ).toEqual({
        id: existingEventTaskId,
        templateId: eventTemplateId,
        targetType: "event",
        targetId: admin.eventId,
        ownerPersonId: null,
        status: "completed",
        lastOperationId: null,
        dueAt: fixedDueAt,
      });
      const dependency = await env.DB.prepare(
        `SELECT dependent.template_id AS templateId,
              prerequisite.template_id AS prerequisiteTemplateId
         FROM task_instance_dependencies edge
         JOIN task_instances dependent ON dependent.id = edge.task_id
         JOIN task_instances prerequisite ON prerequisite.id = edge.depends_on_task_id
        WHERE dependent.template_id = ?`,
      )
        .bind(speakerTemplateId)
        .first();
      expect(dependency).toEqual({
        templateId: speakerTemplateId,
        prerequisiteTemplateId,
      });
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
          WHERE action = 'task.assigned'
            AND json_extract(metadata_json,'$.decisionId') = ?`,
        )
          .bind(result.decisionId)
          .first(),
      ).toEqual({ count: 3 });
      await env.DB.prepare(
        `UPDATE task_templates SET auto_assign_on_acceptance = 0
        WHERE id IN (?,?,?,?)`,
      )
        .bind(
          prerequisiteTemplateId,
          speakerTemplateId,
          sessionTemplateId,
          eventTemplateId,
        )
        .run();
    });

    it("rolls back acceptance when its automatic task graph changes to an invalid state", async () => {
      await resetEvaluationFixture();
      const token = crypto.randomUUID();
      const prerequisiteTemplateId = `acceptance-race-prerequisite-${token}`;
      const templateId = `acceptance-race-task-${token}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO task_templates (
           id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,
           auto_assign_on_acceptance,status
         ) VALUES (?,?,'Race prerequisite','speaker','checklist','high',
                   'checkbox','none',0,'active')`,
        ).bind(prerequisiteTemplateId, admin.eventId),
        env.DB.prepare(
          `INSERT INTO task_templates (
           id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,
           auto_assign_on_acceptance,status
         ) VALUES (?,?,'Race task','speaker','checklist','high',
                   'checkbox','none',1,'active')`,
        ).bind(templateId, admin.eventId),
        env.DB.prepare(
          `INSERT INTO task_template_dependencies (
           template_id,depends_on_template_id,created_at
         ) VALUES (?,?,unixepoch())`,
        ).bind(templateId, prerequisiteTemplateId),
      ]);
      const racingEnv = withBatchRace(evaluationEnvironment(), async () => {
        await env.DB.prepare(
          "UPDATE task_templates SET status = 'archived' WHERE id = ? AND event_id = ?",
        )
          .bind(prerequisiteTemplateId, admin.eventId)
          .run();
      });
      try {
        await expect(
          new EvaluationService(racingEnv).decide(admin, {
            submissionId: "eval-test-submission",
            decision: "accepted",
            rationale: "This plan must be committed as one unit.",
            release: true,
            confirmedWithoutReview: true,
            sessionDurationMinutes: 60,
          }),
        ).rejects.toBeInstanceOf(EvaluationStateError);
        expect(
          await env.DB.prepare(
            `SELECT status,
                  (SELECT COUNT(*) FROM submission_decisions
                    WHERE submission_id = submissions.id) AS decisionCount,
                  (SELECT COUNT(*) FROM sessions
                    WHERE source_submission_id = submissions.id) AS sessionCount,
                  (SELECT COUNT(*) FROM task_instances
                    WHERE template_id IN (?,?)) AS taskCount
             FROM submissions WHERE id = 'eval-test-submission'`,
          )
            .bind(templateId, prerequisiteTemplateId)
            .first(),
        ).toEqual({
          status: "submitted",
          decisionCount: 0,
          sessionCount: 0,
          taskCount: 0,
        });
      } finally {
        await env.DB.prepare("DELETE FROM task_templates WHERE id IN (?,?)")
          .bind(templateId, prerequisiteTemplateId)
          .run();
      }
    });

    it("materialises an accepted session with its configured format default", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(evaluationEnvironment());
      const event = await env.DB.prepare(
        "SELECT session_formats_json AS sessionFormatsJson FROM events WHERE id = ? AND organisation_id = ?",
      )
        .bind(admin.eventId, admin.organisationId)
        .first<{ sessionFormatsJson: string }>();
      expect(event).not.toBeNull();
      const configuredFormats = JSON.parse(event!.sessionFormatsJson) as Array<
        Record<string, unknown>
      >;
      configuredFormats.push({
        key: "round-table",
        label: "Round Table",
        defaultDurationMinutes: 75,
        position: configuredFormats.length,
      });
      try {
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
          ).bind(
            JSON.stringify(configuredFormats),
            admin.eventId,
            admin.organisationId,
          ),
          env.DB.prepare(
            `UPDATE submissions
              SET format = 'Round Table', submitted_snapshot_json = ?
            WHERE id = 'eval-test-submission' AND event_id = ?`,
          ).bind(
            submittedSnapshot({
              format: "Round Table",
              description: "A configured round table.",
            }),
            admin.eventId,
          ),
        ]);

        const result = await service.decide(admin, {
          submissionId: "eval-test-submission",
          decision: "accepted",
          rationale: "Strong programme fit.",
          release: true,
          confirmedWithoutReview: true,
        });
        await expect(
          env.DB.prepare(
            "SELECT format, duration_minutes AS durationMinutes FROM sessions WHERE id = ? AND event_id = ?",
          )
            .bind(result.sessionId, admin.eventId)
            .first(),
        ).resolves.toEqual({ format: "round-table", durationMinutes: 75 });
      } finally {
        await env.DB.prepare(
          "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
        )
          .bind(event!.sessionFormatsJson, admin.eventId, admin.organisationId)
          .run();
      }
    });

    it("fails accepted release if the claimed speaker set changes before provisioning", async () => {
      await resetEvaluationFixture();
      const latePersonId = `eval-late-speaker-${crypto.randomUUID()}`;
      await env.DB.prepare(
        `INSERT INTO people (
         id, email, display_name, email_verified, profile_status,
         created_at, updated_at
       ) VALUES (?, ?, 'Late Speaker', 1, 'draft', unixepoch(), unixepoch())`,
      )
        .bind(latePersonId, `${latePersonId}@example.com`)
        .run();
      const racingEnv = withBatchRace(evaluationEnvironment(), async () => {
        await env.DB.prepare(
          `INSERT INTO submission_speakers (
             id, event_id, submission_id, person_id, email, display_name,
             position, invitation_status, is_primary, claimed_at,
             created_at, updated_at
           ) VALUES (?, ?, 'eval-test-submission', ?, ?, 'Late Speaker', 1,
                     'claimed', 0, unixepoch(), unixepoch(), unixepoch())`,
        )
          .bind(
            crypto.randomUUID(),
            admin.eventId,
            latePersonId,
            `${latePersonId}@example.com`,
          )
          .run();
      });
      try {
        await expect(
          new EvaluationService(racingEnv).decide(admin, {
            submissionId: "eval-test-submission",
            decision: "accepted",
            rationale: "The full speaker set must be provisioned together.",
            release: true,
            confirmedWithoutReview: true,
            sessionDurationMinutes: 60,
          }),
        ).rejects.toBeInstanceOf(EvaluationRevisionConflictError);
        expect(
          await env.DB.prepare(
            `SELECT status,
                  (SELECT COUNT(*) FROM sessions
                    WHERE source_submission_id = submissions.id) AS sessionCount
             FROM submissions WHERE id = 'eval-test-submission'`,
          ).first(),
        ).toEqual({ status: "submitted", sessionCount: 0 });
        expect(
          await env.DB.prepare(
            `SELECT COUNT(*) AS count FROM memberships
            WHERE event_id = ? AND person_id = ? AND role = 'speaker'`,
          )
            .bind(admin.eventId, latePersonId)
            .first(),
        ).toEqual({ count: 0 });
      } finally {
        await env.DB.prepare(
          "DELETE FROM submission_speakers WHERE submission_id = 'eval-test-submission' AND person_id = ?",
        )
          .bind(latePersonId)
          .run();
        await env.DB.prepare("DELETE FROM people WHERE id = ?")
          .bind(latePersonId)
          .run();
      }
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
        env.DB.prepare(
          `INSERT INTO submission_track_selections (
           submission_id, event_id, track_id, track_name_snapshot, position
         ) VALUES (
           'eval-unclaimed-submission', ?,
           'demo-track-operations', 'Operations', 0
         )`,
        ).bind(admin.eventId),
      ]);

      const service = new EvaluationService(evaluationEnvironment());
      await expect(
        service.decide(admin, {
          submissionId: "eval-unclaimed-submission",
          decision: "accepted",
          rationale: "Strong proposal.",
          release: true,
          confirmedWithoutReview: true,
          sessionDurationMinutes: 60,
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
      const service = new EvaluationService(evaluationEnvironment());
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
      await env.DB.prepare(
        `INSERT OR IGNORE INTO submission_track_selections (
         submission_id, event_id, track_id, track_name_snapshot, position
       ) VALUES (
         'eval-active-decision-submission', ?,
         'demo-track-operations', 'Operations', 0
       )`,
      )
        .bind(admin.eventId)
        .run();
      await service.assign(admin, {
        roundId: adminWorkspace.plan!.rounds[0]!.id,
        targetType: "submission",
        targetIds: ["eval-active-decision-submission"],
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
        confirmedWithoutReview: true,
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
  });

  describe("additional workflow coverage", () => {
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
  });

  describe("assignment workflows", () => {
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
      await env.DB.prepare(
        `INSERT OR IGNORE INTO submission_track_selections (
         submission_id, event_id, track_id, track_name_snapshot, position
       ) VALUES (
         'eval-revoked-submission', ?,
         'demo-track-operations', 'Operations', 0
       )`,
      )
        .bind(admin.eventId)
        .run();
      await expect(
        service.assign(admin, {
          roundId: workspace.plan!.rounds[0]!.id,
          targetType: "submission",
          targetIds: ["eval-revoked-submission"],
          evaluatorPersonIds: [evaluator.personId],
        }),
      ).rejects.toThrow(/not authorised/);
    });
  });

  describe("configuration and access workflows", () => {
    it("administers teams and expands a team assignment to its active members", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const teamId = await service.saveTeam(admin, {
        name: "Operations committee",
        description: "Reviews programme operations proposals.",
        chairPersonId: null,
        status: "active",
      });
      await service.changeTeamMember(admin, {
        teamId,
        personId: evaluator.personId,
        role: "evaluator",
        operation: "add",
      });
      await service.savePlan(admin, {
        revision: 0,
        name: "Team assignment plan",
        status: "active",
        rounds: [
          {
            id: "eval-team-round",
            name: "Committee review",
            anonymous: false,
            criteria,
          },
        ],
      });
      const assigned = await service.assign(admin, {
        roundId: "eval-team-round",
        targetType: "submission",
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [],
        teamId,
      });
      expect(assigned).toMatchObject({
        createdAssignmentCount: 1,
        requestedAssignmentCount: 1,
        undoOperationId: expect.any(String),
        undoExpiresAt: expect.any(Number),
      });
      const repeated = await service.assign(admin, {
        roundId: "eval-team-round",
        targetType: "submission",
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [],
        teamId,
      });
      expect(repeated).toMatchObject({
        createdAssignmentCount: 0,
        requestedAssignmentCount: 1,
        undoOperationId: null,
        undoExpiresAt: null,
      });

      const workspace = await service.getAdminWorkspace(admin);
      expect(workspace.teams).toContainEqual(
        expect.objectContaining({
          id: teamId,
          name: "Operations committee",
          memberCount: 1,
          members: [expect.objectContaining({ personId: evaluator.personId })],
        }),
      );
      expect(workspace.assignments).toContainEqual(
        expect.objectContaining({
          roundId: "eval-team-round",
          submissionId: "eval-test-submission",
          evaluatorPersonId: evaluator.personId,
          teamId,
        }),
      );
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
          WHERE event_id = ? AND action = 'evaluation.assignments.created'
            AND json_extract(metadata_json, '$.teamId') = ?`,
        )
          .bind(admin.eventId, teamId)
          .first<{ count: number }>(),
      ).toEqual({ count: 1 });

      await env.DB.prepare(
        `UPDATE memberships SET revoked_at = unixepoch()
        WHERE event_id = ? AND person_id = ? AND role = 'evaluator'`,
      )
        .bind(admin.eventId, evaluator.personId)
        .run();
      await service.changeTeamMember(admin, {
        teamId,
        personId: evaluator.personId,
        role: "evaluator",
        operation: "remove",
      });
      const afterRemoval = await service.getAdminWorkspace(admin);
      expect(
        afterRemoval.teams.find((team) => team.id === teamId)?.members,
      ).toEqual([]);
      expect(
        afterRemoval.assignments.find(
          (assignment) => assignment.submissionId === "eval-test-submission",
        )?.teamId,
      ).toBe(teamId);
    });

    it("fails the admin queue when legacy routing lacks authoritative team joins", async () => {
      await resetEvaluationFixture();
      const testEnv = env as unknown as CloudflareEnvironment;
      const service = new EvaluationService(evaluationEnvironment(testEnv));
      const teamId = `eval-incomplete-routing-${crypto.randomUUID()}`;
      await testEnv.DB.prepare(
        `INSERT INTO evaluation_teams (
         id, event_id, name, description, chair_person_id, status,
         created_at, updated_at
       ) VALUES (?, ?, ?, '', NULL, 'active', unixepoch(), unixepoch())`,
      )
        .bind(teamId, admin.eventId, `Incomplete routing ${teamId}`)
        .run();
      try {
        await testEnv.DB.prepare(
          `UPDATE submissions
            SET status = 'assigned', routed_team_id = ?
          WHERE id = 'eval-test-submission' AND event_id = ?`,
        )
          .bind(teamId, admin.eventId)
          .run();

        await expect(service.getAdminWorkspace(admin)).rejects.toThrow(
          /incomplete persisted routing teams/i,
        );
      } finally {
        await testEnv.DB.batch([
          testEnv.DB.prepare(
            `UPDATE submissions
              SET status = 'submitted', routed_team_id = NULL
            WHERE id = 'eval-test-submission' AND event_id = ?`,
          ).bind(admin.eventId),
          testEnv.DB.prepare(
            `DELETE FROM evaluation_teams WHERE id = ? AND event_id = ?`,
          ).bind(teamId, admin.eventId),
        ]);
      }
    });
  });

  describe("assignment workflows", () => {
    it("fails the admin queue when a submission lacks authoritative tracks", async () => {
      await resetEvaluationFixture();
      await env.DB.prepare(
        `DELETE FROM submission_track_selections
        WHERE submission_id = 'eval-test-submission' AND event_id = ?`,
      )
        .bind(admin.eventId)
        .run();

      await expect(
        new EvaluationService(evaluationEnvironment()).getAdminWorkspace(admin),
      ).rejects.toThrow(/missing persisted track selections/i);
    });

    it("replays an assistant assignment command for the authenticated administrator", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      await service.savePlan(admin, {
        revision: 0,
        name: "Assistant assignment plan",
        status: "active",
        rounds: [
          {
            id: "eval-assistant-assignment-round",
            name: "Assistant assignment round",
            anonymous: false,
            criteria,
          },
        ],
      });
      const input = {
        roundId: "eval-assistant-assignment-round",
        targetType: "submission" as const,
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
      };
      const command = {
        actorId: `assistant:${admin.personId}`,
        idempotencyKey: `assistant:${crypto.randomUUID()}`,
        requestHash: "a".repeat(64),
      };
      const assigned = await service.assign(admin, input, command);
      await expect(service.assign(admin, input, command)).resolves.toEqual(
        assigned,
      );
      expect(assigned).toMatchObject({
        createdAssignmentCount: 1,
        requestedAssignmentCount: 1,
        undoOperationId: expect.any(String),
      });
    });

    it("undoes only a fresh untouched assignment operation", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      await service.savePlan(admin, {
        revision: 0,
        name: "Undoable assignment plan",
        status: "active",
        rounds: [
          {
            id: "eval-undo-round",
            name: "Initial review",
            anonymous: false,
            criteria,
          },
        ],
      });
      const assigned = await service.assign(admin, {
        roundId: "eval-undo-round",
        targetType: "submission",
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
      });
      expect(assigned.undoOperationId).toEqual(expect.any(String));

      await expect(
        service.undoAssignments(admin, {
          operationId: assigned.undoOperationId,
          confirmed: true,
        }),
      ).resolves.toEqual({ undoneAssignmentCount: 1 });
      expect(
        await env.DB.prepare(
          `SELECT status,
                (SELECT COUNT(*) FROM evaluator_assignments
                  WHERE event_id = submissions.event_id
                    AND submission_id = submissions.id) AS assignmentCount
           FROM submissions WHERE id = 'eval-test-submission' AND event_id = ?`,
        )
          .bind(admin.eventId)
          .first(),
      ).toEqual({ status: "submitted", assignmentCount: 0 });

      const reassigned = await service.assign(admin, {
        roundId: "eval-undo-round",
        targetType: "submission",
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
      });
      const reviewerWorkspace = await service.getReviewerWorkspace(evaluator);
      await service.saveReview(evaluator, {
        assignmentId: reviewerWorkspace.selected!.id,
        revision: 0,
        scores: {},
        recommendation: null,
        confidence: null,
        submitterFeedback: "",
        privateNotes: "Started reviewing.",
        intent: "save",
      });
      await expect(
        service.undoAssignments(admin, {
          operationId: reassigned.undoOperationId,
          confirmed: true,
        }),
      ).rejects.toThrow(/review work started/);
    });
  });

  describe("additional workflow coverage", () => {
    it("records API-key actors for admin-safe evaluation commands", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const apiActor = {
        kind: "api_key" as const,
        organisationId: admin.organisationId,
        eventId: admin.eventId,
        personId: null,
        actorId: "api_key:evaluation-test",
      };
      const planInput = {
        revision: 0,
        name: "API evaluation plan",
        status: "active" as const,
        rounds: [
          {
            id: "eval-api-round",
            name: "API review",
            anonymous: false,
            criteria,
          },
        ],
      };
      const planCommand = {
        idempotencyKey: "evaluation-plan-key",
        requestHash: "evaluation-plan-hash",
      };
      const [planId, concurrentPlanId] = await Promise.all([
        service.savePlan(apiActor, planInput, planCommand),
        service.savePlan(apiActor, planInput, planCommand),
      ]);
      expect(concurrentPlanId).toBe(planId);
      await expect(
        service.savePlan(apiActor, planInput, planCommand),
      ).resolves.toBe(planId);
      await expect(
        service.savePlan(apiActor, planInput, {
          ...planCommand,
          requestHash: "different-plan-hash",
        }),
      ).rejects.toThrow(/different evaluation request/);
      const roundInput = {
        planId,
        planRevision: 1,
        name: "API final review",
        dueAt: null,
        cloneRoundId: "eval-api-round",
      };
      const roundCommand = {
        idempotencyKey: "evaluation-round-key",
        requestHash: "evaluation-round-hash",
      };
      const nextRoundId = await service.addNextRound(
        apiActor,
        roundInput,
        roundCommand,
      );
      await expect(
        service.addNextRound(apiActor, roundInput, roundCommand),
      ).resolves.toBe(nextRoundId);
      const assignmentInput = {
        roundId: "eval-api-round",
        targetType: "submission" as const,
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
      };
      const assignmentCommand = {
        idempotencyKey: "evaluation-assignment-key",
        requestHash: "evaluation-assignment-hash",
      };
      const assignment = await service.assign(
        apiActor,
        assignmentInput,
        assignmentCommand,
      );
      await expect(
        service.assign(apiActor, assignmentInput, assignmentCommand),
      ).resolves.toEqual(assignment);
      const auditActors = await env.DB.prepare(
        `SELECT action, actor_person_id AS actorPersonId, actor_id AS actorId
         FROM audit_events
        WHERE event_id = ? AND actor_id = ?
        ORDER BY action`,
      )
        .bind(admin.eventId, apiActor.actorId)
        .all<{
          action: string;
          actorPersonId: string | null;
          actorId: string;
        }>();
      expect(auditActors.results).toEqual([
        {
          action: "evaluation.assignments.created",
          actorPersonId: null,
          actorId: apiActor.actorId,
        },
        {
          action: "evaluation.plan.saved",
          actorPersonId: null,
          actorId: apiActor.actorId,
        },
        {
          action: "evaluation.round.created",
          actorPersonId: null,
          actorId: apiActor.actorId,
        },
      ]);
    });
  });

  describe("configuration and access workflows", () => {
    it("keeps the team's named chair and active chair membership in sync", async () => {
      await resetEvaluationFixture();
      await env.DB.prepare(
        `
      INSERT OR IGNORE INTO memberships (
        id, organisation_id, event_id, person_id, role,
        invited_at, accepted_at, created_at
      ) VALUES (
        'eval-test-chair-membership', ?, ?, ?, 'committee_chair',
        unixepoch(), unixepoch(), unixepoch()
      )
    `,
      )
        .bind(admin.organisationId, admin.eventId, admin.personId)
        .run();
      try {
        const service = new EvaluationService(
          env as unknown as CloudflareEnvironment,
        );
        const teamId = await service.saveTeam(admin, {
          name: "Named chair committee",
          description: "Tests the single chair invariant.",
          chairPersonId: admin.personId,
          status: "active",
        });
        expect(
          await env.DB.prepare(
            `
          SELECT t.chair_person_id AS chairPersonId, tm.role
            FROM evaluation_teams t
            JOIN evaluation_team_members tm
              ON tm.team_id = t.id AND tm.event_id = t.event_id
           WHERE t.id = ? AND t.event_id = ? AND tm.person_id = ?
             AND tm.removed_at IS NULL
        `,
          )
            .bind(teamId, admin.eventId, admin.personId)
            .first(),
        ).toEqual({ chairPersonId: admin.personId, role: "chair" });

        await service.changeTeamMember(admin, {
          teamId,
          personId: admin.personId,
          role: "evaluator",
          operation: "add",
        });
        expect(
          await env.DB.prepare(
            `
          SELECT t.chair_person_id AS chairPersonId, tm.role
            FROM evaluation_teams t
            JOIN evaluation_team_members tm
              ON tm.team_id = t.id AND tm.event_id = t.event_id
           WHERE t.id = ? AND t.event_id = ? AND tm.person_id = ?
             AND tm.removed_at IS NULL
        `,
          )
            .bind(teamId, admin.eventId, admin.personId)
            .first(),
        ).toEqual({ chairPersonId: null, role: "evaluator" });

        await service.saveTeam(admin, {
          teamId,
          name: "Named chair committee",
          description: "Tests the single chair invariant.",
          chairPersonId: admin.personId,
          status: "active",
        });

        await service.saveTeam(admin, {
          teamId,
          name: "Named chair committee",
          description: "Tests the single chair invariant.",
          chairPersonId: null,
          status: "active",
        });
        expect(
          await env.DB.prepare(
            `
          SELECT t.chair_person_id AS chairPersonId, tm.role
            FROM evaluation_teams t
            JOIN evaluation_team_members tm
              ON tm.team_id = t.id AND tm.event_id = t.event_id
           WHERE t.id = ? AND t.event_id = ? AND tm.person_id = ?
             AND tm.removed_at IS NULL
        `,
          )
            .bind(teamId, admin.eventId, admin.personId)
            .first(),
        ).toEqual({ chairPersonId: null, role: "evaluator" });
      } finally {
        await env.DB.prepare(
          "DELETE FROM memberships WHERE id = 'eval-test-chair-membership'",
        ).run();
      }
    });

    it("creates expiring evaluator invitations and activates team eligibility only after acceptance", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const teamId = await service.saveTeam(admin, {
        name: "Invited evaluators",
        description: "Invitation onboarding coverage.",
        chairPersonId: null,
        status: "active",
      });
      try {
        const invited = await service.inviteEvaluationMember(admin, {
          name: "Taylor Reviewer",
          email: "taylor.reviewer@example.com",
          role: "evaluator",
          teamId,
        });
        expect(invited.delivery).toBe("demo_not_sent");
        const membership = await env.DB.prepare(
          `
        SELECT m.id, m.accepted_at AS acceptedAt,
               m.invitation_expires_at AS expiresAt,
               (SELECT COUNT(*) FROM audit_events audit
                 WHERE audit.entity_id = m.id
                   AND audit.action = 'membership.evaluator.invited') AS inviteAuditCount
          FROM memberships m
          JOIN people p ON p.id = m.person_id
         WHERE m.event_id = ? AND m.role = 'evaluator' AND p.email = ?
      `,
        )
          .bind(admin.eventId, "taylor.reviewer@example.com")
          .first<{
            id: string;
            acceptedAt: number | null;
            expiresAt: number;
            inviteAuditCount: number;
          }>();
        expect(membership).toMatchObject({
          id: invited.membershipId,
          acceptedAt: null,
          inviteAuditCount: 1,
        });
        expect(membership!.expiresAt).toBeGreaterThan(
          Math.floor(Date.now() / 1_000),
        );
        const workspace = await service.getAdminWorkspace(admin);
        expect(workspace.evaluationInvitations).toContainEqual(
          expect.objectContaining({
            id: invited.membershipId,
            email: "taylor.reviewer@example.com",
            status: "pending",
          }),
        );
        expect(
          workspace.teams.find((team) => team.id === teamId),
        ).toMatchObject({
          eligibleMemberCount: 0,
          members: [
            expect.objectContaining({
              email: "taylor.reviewer@example.com",
              authorised: false,
            }),
          ],
        });

        await env.DB.prepare(
          "UPDATE memberships SET invitation_expires_at = unixepoch() - 1 WHERE id = ?",
        )
          .bind(invited.membershipId)
          .run();
        expect(
          (await service.getAdminWorkspace(admin)).evaluationInvitations,
        ).toContainEqual(
          expect.objectContaining({
            id: invited.membershipId,
            status: "expired",
          }),
        );

        const resent = await service.inviteEvaluationMember(admin, {
          name: "Taylor Reviewer",
          email: "taylor.reviewer@example.com",
          role: "evaluator",
          teamId,
        });
        expect(resent.membershipId).toBe(invited.membershipId);
        expect(
          (await service.getAdminWorkspace(admin)).evaluationInvitations,
        ).toContainEqual(
          expect.objectContaining({
            id: invited.membershipId,
            status: "pending",
          }),
        );
        expect(
          await env.DB.prepare(
            `
          SELECT COUNT(*) AS count FROM memberships m
          JOIN people p ON p.id = m.person_id
           WHERE m.event_id = ? AND m.role = 'evaluator' AND p.email = ?
        `,
          )
            .bind(admin.eventId, "taylor.reviewer@example.com")
            .first<{ count: number }>(),
        ).toEqual({ count: 1 });
        await env.DB.prepare(
          `UPDATE memberships SET accepted_at = unixepoch()
          WHERE id = ? AND accepted_at IS NULL`,
        )
          .bind(invited.membershipId)
          .run();
        const acceptedWorkspace = await service.getAdminWorkspace(admin);
        expect(acceptedWorkspace.evaluationInvitations).toEqual([]);
        expect(
          acceptedWorkspace.teams.find((team) => team.id === teamId),
        ).toMatchObject({ eligibleMemberCount: 1 });
        expect(acceptedWorkspace.evaluators).toContainEqual(
          expect.objectContaining({ email: "taylor.reviewer@example.com" }),
        );
        await expect(
          service.inviteEvaluationMember(admin, {
            name: "Taylor Reviewer",
            email: "taylor.reviewer@example.com",
            role: "evaluator",
            teamId,
          }),
        ).rejects.toThrow(/already has active evaluator access/i);
      } finally {
        await env.DB.prepare(
          "DELETE FROM people WHERE email = 'taylor.reviewer@example.com'",
        ).run();
      }
    });

    it("invites, promotes and revokes committee chairs with administrator-only authority", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const inviteEmail = "invited.committee.chair@example.com";
      try {
        const invitation = await service.inviteEvaluationMember(admin, {
          name: "Invited Committee Chair",
          email: inviteEmail,
          role: "committee_chair",
          teamId: null,
        });
        expect(invitation.delivery).toBe("demo_not_sent");
        expect(
          (await service.getAdminWorkspace(admin)).evaluationInvitations,
        ).toContainEqual(
          expect.objectContaining({
            id: invitation.membershipId,
            email: inviteEmail,
            role: "committee_chair",
            status: "pending",
          }),
        );
        await expect(
          service.inviteEvaluationMember(admin, {
            name: "Invalid team chair invitation",
            email: "invalid.team.chair@example.com",
            role: "committee_chair",
            teamId: "any-team",
          }),
        ).rejects.toThrow(/assign them to a team after acceptance/i);
        await expect(
          service.inviteEvaluationMember(committeeChair, {
            name: "Unauthorised Chair",
            email: "unauthorised.chair@example.com",
            role: "committee_chair",
            teamId: null,
          }),
        ).rejects.toMatchObject({ status: 403 });

        const promoted = await service.changeCommitteeChairAccess(admin, {
          personId: evaluator.personId,
          operation: "promote",
          confirmed: true,
        });
        expect(
          (await service.getAdminWorkspace(admin)).evaluators,
        ).toContainEqual(
          expect.objectContaining({
            id: evaluator.personId,
            role: "committee_chair",
            chairMembershipId: promoted.membershipId,
          }),
        );
        const teamId = await service.saveTeam(admin, {
          name: "Chair lifecycle team",
          description: "Role lifecycle coverage.",
          chairPersonId: evaluator.personId,
          status: "active",
        });
        const revoked = await service.changeCommitteeChairAccess(admin, {
          personId: evaluator.personId,
          operation: "revoke",
          confirmed: true,
        });
        expect(revoked.membershipId).toBe(promoted.membershipId);
        expect(
          await env.DB.prepare(
            `SELECT revoked_at IS NOT NULL AS revoked
             FROM memberships WHERE id = ?`,
          )
            .bind(promoted.membershipId)
            .first(),
        ).toEqual({ revoked: 1 });
        expect(
          await env.DB.prepare(
            "SELECT chair_person_id AS chairPersonId FROM evaluation_teams WHERE id = ?",
          )
            .bind(teamId)
            .first(),
        ).toEqual({ chairPersonId: null });
        expect(
          await env.DB.prepare(
            `SELECT COUNT(*) AS count FROM audit_events
            WHERE event_id = ? AND entity_id = ?
              AND action IN (
                'membership.committee_chair.promoted',
                'membership.committee_chair.revoked'
              )`,
          )
            .bind(admin.eventId, promoted.membershipId)
            .first(),
        ).toEqual({ count: 2 });
        await expect(
          service.changeCommitteeChairAccess(committeeChair, {
            personId: evaluator.personId,
            operation: "promote",
            confirmed: true,
          }),
        ).rejects.toMatchObject({ status: 403 });
      } finally {
        await env.DB.prepare("DELETE FROM people WHERE email IN (?, ?, ?)")
          .bind(
            inviteEmail,
            "invalid.team.chair@example.com",
            "unauthorised.chair@example.com",
          )
          .run();
      }
    });

    it("enforces evaluation-manager authority in the service layer", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      await expect(
        service.saveTeam(evaluator, {
          name: "Unauthorised team",
          description: "",
          chairPersonId: null,
          status: "active",
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.inviteEvaluationMember(evaluator, {
          name: "Unauthorised evaluator",
          email: "unauthorised.evaluator@example.com",
          role: "evaluator",
          teamId: null,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("round workflows", () => {
    it("closes a completed round, locks its review and advances a shortlist atomically", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const planId = await service.savePlan(admin, {
        revision: 0,
        name: "Two-round plan",
        status: "active",
        rounds: [
          {
            id: "eval-multi-round-one",
            name: "Initial review",
            anonymous: false,
            criteria,
          },
        ],
      });
      const nextRoundId = await service.addNextRound(admin, {
        planId,
        planRevision: 1,
        name: "Final review draft",
        dueAt: null,
        cloneRoundId: "eval-multi-round-one",
      });
      const draftRoundUpdate = {
        roundId: nextRoundId,
        revision: 1,
        name: "Final review",
        dueAt: null,
        criteria: criteria.map((criterion) => ({
          ...criterion,
          id: `${criterion.id}-final`,
        })),
      };
      const roundOperation = {
        operationId: `assistant:${crypto.randomUUID()}`,
        auditId: `assistant-rubric-audit:${crypto.randomUUID()}`,
      };
      await service.updateDraftRound(admin, draftRoundUpdate, roundOperation);
      await expect(
        service.updateDraftRound(admin, draftRoundUpdate, roundOperation),
      ).resolves.toBeUndefined();
      await env.DB.prepare(
        `
      INSERT INTO submissions (
        id, event_id, form_version_id, submitter_person_id, submitter_email,
        public_reference, title, category, format, status, answers_json,
        submitted_snapshot_json, revision, submitted_at, created_at, updated_at
      ) VALUES (
        'eval-multi-round-not-advanced', ?, 'eval-test-form-v1',
        'person-demo-submitter', 'alex.submitter@example.com',
        'SUB-EVAL-NOT-ADVANCED', 'Proposal not shortlisted', 'Operations',
        'Presentation', 'submitted', '{}', ?, 1,
        unixepoch(), unixepoch(), unixepoch()
      )
    `,
      )
        .bind(admin.eventId, submittedSnapshot())
        .run();
      await service.assign(admin, {
        roundId: "eval-multi-round-one",
        targetType: "submission",
        targetIds: ["eval-test-submission", "eval-multi-round-not-advanced"],
        evaluatorPersonIds: [evaluator.personId],
      });
      const queue = await service.getReviewerWorkspace(evaluator);
      const firstWorkspace = await service.getReviewerWorkspace(
        evaluator,
        queue.assignments.find(
          (assignment) => assignment.submissionId === "eval-test-submission",
        )!.id,
      );
      const submitted = await service.saveReview(evaluator, {
        assignmentId: firstWorkspace.selected!.id,
        revision: 0,
        scores: Object.fromEntries(
          firstWorkspace.criteria.map((criterion) => [criterion.id, 5]),
        ),
        recommendation: "accept",
        confidence: 5,
        submitterFeedback: "Strong proposal.",
        privateNotes: "Advance to the final round.",
        intent: "submit",
      });
      const nonAdvancedWorkspace = await service.getReviewerWorkspace(
        evaluator,
        queue.assignments.find(
          (assignment) =>
            assignment.submissionId === "eval-multi-round-not-advanced",
        )!.id,
      );
      await service.saveReview(evaluator, {
        assignmentId: nonAdvancedWorkspace.selected!.id,
        revision: 0,
        scores: Object.fromEntries(
          nonAdvancedWorkspace.criteria.map((criterion) => [criterion.id, 3]),
        ),
        recommendation: "reject",
        confidence: 4,
        submitterFeedback: "Not selected for the final round.",
        privateNotes: "Conclude after the first round.",
        intent: "submit",
      });

      const advanceInput = {
        fromRoundId: "eval-multi-round-one",
        fromRoundRevision: 1,
        toRoundId: nextRoundId,
        toRoundRevision: 2,
        submissionIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
        teamId: null,
        confirmed: true as const,
      };
      const advanceActor = {
        kind: "api_key" as const,
        organisationId: admin.organisationId,
        eventId: admin.eventId,
        personId: null,
        actorId: "api_key:evaluation-advance-test",
      };
      const advanceCommand = {
        idempotencyKey: "evaluation-advance-key",
        requestHash: "evaluation-advance-hash",
      };
      const result = await service.advanceRound(
        advanceActor,
        advanceInput,
        advanceCommand,
      );
      expect(result).toEqual({
        advancedSubmissionCount: 1,
        assignmentCount: 1,
      });
      await expect(
        service.advanceRound(advanceActor, advanceInput, advanceCommand),
      ).resolves.toEqual(result);
      const state = await env.DB.prepare(
        `
      SELECT
        (SELECT status FROM evaluation_rounds WHERE id = 'eval-multi-round-one') AS firstStatus,
        (SELECT status FROM evaluation_rounds WHERE id = ?) AS secondStatus,
        (SELECT status FROM reviews WHERE id = ?) AS reviewStatus,
        (SELECT status FROM submissions WHERE id = 'eval-test-submission') AS submissionStatus,
        (SELECT status FROM submissions
          WHERE id = 'eval-multi-round-not-advanced') AS nonAdvancedSubmissionStatus,
        (SELECT COUNT(*) FROM evaluator_assignments
          WHERE round_id = ?
            AND submission_id = 'eval-test-submission'
            AND status = 'assigned') AS nextAssignmentCount,
        (SELECT COUNT(*) FROM evaluator_assignments
          WHERE round_id = ?
            AND submission_id = 'eval-multi-round-not-advanced') AS nonAdvancedAssignmentCount
    `,
      )
        .bind(nextRoundId, submitted.reviewId, nextRoundId, nextRoundId)
        .first();
      expect(state).toEqual({
        firstStatus: "closed",
        secondStatus: "active",
        reviewStatus: "locked",
        submissionStatus: "assigned",
        nonAdvancedSubmissionStatus: "decision_ready",
        nextAssignmentCount: 1,
        nonAdvancedAssignmentCount: 0,
      });
      const nextWorkspace = await service.getReviewerWorkspace(evaluator);
      expect(nextWorkspace.selected).toMatchObject({
        submissionId: "eval-test-submission",
        status: "assigned",
      });
    });

    it("supports mixed rubric inputs, confirmed moderation and explicit review reopening", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      await service.savePlan(admin, {
        revision: 0,
        name: "Moderated mixed rubric",
        status: "active",
        rounds: [
          {
            id: "eval-moderation-round",
            name: "Panel review",
            anonymous: false,
            criteria: [
              {
                id: "eval-scale-ten",
                name: "Programme fit",
                description: "Score from one to ten.",
                inputType: "scale_10",
                weightPercent: 100,
                required: true,
                position: 0,
              },
              {
                id: "eval-yes-no",
                name: "Evidence supplied",
                description: "Confirm the evidence is present.",
                inputType: "yes_no",
                weightPercent: 0,
                required: true,
                position: 1,
              },
              {
                id: "eval-free-text",
                name: "Panel context",
                description: "Record supporting context.",
                inputType: "free_text",
                weightPercent: 0,
                required: false,
                position: 2,
              },
            ],
          },
        ],
      });
      await service.assign(admin, {
        roundId: "eval-moderation-round",
        targetType: "submission",
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
      });
      const hiddenVideoSnapshot = JSON.parse(
        submittedSnapshot(
          {
            title: "Immutable submitted title",
            category: "Immutable submitted category",
            format: "Immutable submitted format",
            description: "A practical description for the public programme.",
            biography: "Alex Morgan is the identifying speaker biography.",
          },
          "eval-test-form-v1",
          "reviewers",
        ),
      ) as {
        schema: { fields: Array<Record<string, unknown>> };
        uploads: Record<string, { assetId: string; versionId: string }>;
      };
      hiddenVideoSnapshot.schema.fields.push({
        id: "private_video",
        label: "Private pitch video",
        type: "video",
        required: false,
        help: "",
        options: [],
        reviewVisibility: "administrators_only",
        condition: null,
      });
      hiddenVideoSnapshot.uploads = {
        private_video: {
          assetId: "eval-private-review-video",
          versionId: "eval-private-review-video-v1",
        },
      };
      await env.DB.prepare(
        `
      UPDATE submissions
         SET title = 'Changed live title', category = 'Changed live category',
             format = 'Changed live format', submitted_snapshot_json = ?
       WHERE id = 'eval-test-submission' AND event_id = ?
    `,
      )
        .bind(JSON.stringify(hiddenVideoSnapshot), admin.eventId)
        .run();
      const uploadedAttachment = await env.FILES.put(
        "evaluation-test/reviewer-attachment.txt",
        "reviewer attachment",
      );
      const hiddenVideo = await env.FILES.put(
        "evaluation-test/private-review-video.mp4",
        "private pitch video",
      );
      if (!uploadedAttachment || !hiddenVideo) {
        throw new Error("Evaluation attachment fixtures were not stored.");
      }
      await env.DB.batch([
        env.DB.prepare(
          `
        INSERT INTO file_assets (
          id, event_id, owner_person_id, target_type, target_id,
          asset_kind, status, created_at, updated_at
        ) VALUES (
          'eval-review-attachment', ?, 'person-demo-submitter', 'submission',
          'eval-test-submission', 'supporting_document', 'active',
          unixepoch(), unixepoch()
        )
      `,
        ).bind(admin.eventId),
        env.DB.prepare(
          `
        INSERT INTO file_versions (
          id, event_id, asset_id, version_number, object_key,
          original_filename, declared_content_type, detected_content_type,
          size_bytes, object_etag, upload_status, signature_status, scan_status,
          created_by_person_id, created_at, uploaded_at, scanned_at, released_at
        ) VALUES (
          'eval-review-attachment-v1', ?, 'eval-review-attachment', 1,
          'evaluation-test/reviewer-attachment.txt', 'evidence.txt',
          'text/plain', 'text/plain', 19, ?, 'uploaded', 'valid', 'clean',
          'person-demo-submitter', unixepoch(), unixepoch(), unixepoch(),
          unixepoch()
        )
      `,
        ).bind(admin.eventId, uploadedAttachment.httpEtag),
        env.DB.prepare(
          `UPDATE file_assets SET current_version_id = 'eval-review-attachment-v1'
          WHERE id = 'eval-review-attachment' AND event_id = ?`,
        ).bind(admin.eventId),
        env.DB.prepare(
          `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id,
           asset_kind, status, created_at, updated_at
         ) VALUES (
           'eval-private-review-video', ?, 'person-demo-submitter',
           'submission', 'eval-test-submission', 'video', 'active',
           unixepoch(), unixepoch()
         )`,
        ).bind(admin.eventId),
        env.DB.prepare(
          `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status, scan_status,
           created_by_person_id, created_at, uploaded_at, scanned_at, released_at
         ) VALUES (
           'eval-private-review-video-v1', ?, 'eval-private-review-video', 1,
           'evaluation-test/private-review-video.mp4', 'private-pitch.mp4',
           'video/mp4', 'video/mp4', 19, ?, 'uploaded', 'valid', 'clean',
           'person-demo-submitter', unixepoch(), unixepoch(), unixepoch(),
           unixepoch()
         )`,
        ).bind(admin.eventId, hiddenVideo.httpEtag),
        env.DB.prepare(
          `UPDATE file_assets
            SET current_version_id = 'eval-private-review-video-v1'
          WHERE id = 'eval-private-review-video' AND event_id = ?`,
        ).bind(admin.eventId),
      ]);
      const reviewerWorkspace = await service.getReviewerWorkspace(evaluator);
      expect(reviewerWorkspace.submission).toMatchObject({
        title: "Immutable submitted title",
        category: "Immutable submitted category",
        format: "Immutable submitted format",
        speakerNames: ["Alex Morgan"],
      });
      expect(reviewerWorkspace.submission?.answers).not.toHaveProperty(
        "biography",
      );
      expect(
        reviewerWorkspace.submission?.answerFields.map((field) => field.id),
      ).toEqual(["title", "category", "format", "description"]);
      expect(reviewerWorkspace.attachments).toEqual([]);
      await expect(
        service.downloadReviewerAttachment(
          evaluator,
          "eval-private-review-video",
        ),
      ).rejects.toMatchObject({ status: 404 });
      const administratorVideo = await service.downloadReviewerAttachment(
        admin,
        "eval-private-review-video",
      );
      expect(
        new TextDecoder().decode(await administratorVideo.arrayBuffer()),
      ).toBe("private pitch video");
      await expect(
        service.downloadReviewerAttachment(evaluator, "eval-review-attachment"),
      ).rejects.toMatchObject({ status: 404 });

      const privateVideoField = hiddenVideoSnapshot.schema.fields.find(
        (field) => field.id === "private_video",
      );
      if (!privateVideoField)
        throw new Error("Private video field is missing.");
      privateVideoField.reviewVisibility = "reviewers";
      await env.DB.prepare(
        `UPDATE submissions SET submitted_snapshot_json = ?
        WHERE id = 'eval-test-submission' AND event_id = ?`,
      )
        .bind(JSON.stringify(hiddenVideoSnapshot), admin.eventId)
        .run();
      const visibleAttachmentWorkspace =
        await service.getReviewerWorkspace(evaluator);
      expect(visibleAttachmentWorkspace.attachments).toEqual([
        expect.objectContaining({
          id: "eval-private-review-video",
          filename: "private-pitch.mp4",
          downloadHref: "/review/files/eval-private-review-video",
        }),
      ]);
      const attachment = await service.downloadReviewerAttachment(
        evaluator,
        "eval-private-review-video",
      );
      expect(new TextDecoder().decode(await attachment.arrayBuffer())).toBe(
        "private pitch video",
      );
      expect(attachment.headers.get("Cache-Control")).toBe("private, no-store");
      await expect(
        service.downloadReviewerAttachment(
          { ...evaluator, personId: "person-without-assignment" },
          "eval-private-review-video",
        ),
      ).rejects.toMatchObject({ status: 404 });
      await env.FILES.put(
        "evaluation-test/private-review-video.mp4",
        "unscanned replacement",
      );
      await expect(
        service.downloadReviewerAttachment(
          evaluator,
          "eval-private-review-video",
        ),
      ).rejects.toThrow("differs from its scanned object");
      hiddenVideoSnapshot.uploads.private_video.versionId =
        "eval-private-review-video-stale";
      await env.DB.prepare(
        `UPDATE submissions SET submitted_snapshot_json = ?
        WHERE id = 'eval-test-submission' AND event_id = ?`,
      )
        .bind(JSON.stringify(hiddenVideoSnapshot), admin.eventId)
        .run();
      await expect(
        service.getReviewerWorkspace(evaluator),
      ).resolves.toMatchObject({ attachments: [] });
      await expect(
        service.downloadReviewerAttachment(
          evaluator,
          "eval-private-review-video",
        ),
      ).rejects.toMatchObject({ status: 404 });
      const submitted = await service.saveReview(evaluator, {
        assignmentId: reviewerWorkspace.selected!.id,
        revision: 0,
        scores: {
          "eval-scale-ten": "10",
          "eval-yes-no": "yes",
          "eval-free-text": "The evidence is clear.",
        },
        recommendation: "accept",
        confidence: 5,
        submitterFeedback: "Well evidenced.",
        privateNotes: "Ready for moderation.",
        intent: "submit",
      });
      expect(submitted.weightedScore).toBe(5);
      const savedResponses = await env.DB.prepare(
        "SELECT scores_json AS scoresJson FROM reviews WHERE id = ?",
      )
        .bind(submitted.reviewId)
        .first<{ scoresJson: string }>();
      expect(JSON.parse(savedResponses!.scoresJson)).toEqual({
        "eval-scale-ten": 10,
        "eval-yes-no": true,
        "eval-free-text": "The evidence is clear.",
      });

      const draftModerationId = await service.moderate(admin, {
        roundId: "eval-moderation-round",
        submissionId: "eval-test-submission",
        expectedModerationId: null,
        recommendation: "advance",
        moderatedScore: 4.75,
        notes: "The panel agrees this proposal should advance.",
        status: "draft",
        confirmed: false,
      });
      const confirmedModerationId = await service.moderate(admin, {
        roundId: "eval-moderation-round",
        submissionId: "eval-test-submission",
        expectedModerationId: draftModerationId,
        recommendation: "advance",
        moderatedScore: 4.75,
        notes: "The panel confirmed this outcome.",
        status: "confirmed",
        confirmed: true,
      });
      expect(confirmedModerationId).not.toBe(draftModerationId);

      const reopened = await service.reopenReview(admin, {
        assignmentId: reviewerWorkspace.selected!.id,
        reason: "The evaluator must correct a material factual error.",
        confirmed: true,
      });
      expect(reopened).toEqual({
        reviewId: submitted.reviewId,
        revision: 2,
        webhookDeliveries: [],
      });
      const state = await env.DB.prepare(
        `
      SELECT
        (SELECT status FROM evaluator_assignments WHERE id = ?) AS assignmentStatus,
        (SELECT status FROM reviews WHERE id = ?) AS reviewStatus,
        (SELECT status FROM review_moderations WHERE id = ?) AS moderationStatus,
        (SELECT status FROM submissions WHERE id = 'eval-test-submission') AS submissionStatus,
        (SELECT COUNT(*) FROM review_revisions
          WHERE review_id = ? AND save_kind = 'reopened') AS reopenRevisionCount
    `,
      )
        .bind(
          reviewerWorkspace.selected!.id,
          submitted.reviewId,
          confirmedModerationId,
          submitted.reviewId,
        )
        .first();
      expect(state).toEqual({
        assignmentStatus: "reopened",
        reviewStatus: "reopened",
        moderationStatus: "superseded",
        submissionStatus: "in_review",
        reopenRevisionCount: 1,
      });
      const reopenedWorkspace = await service.getReviewerWorkspace(evaluator);
      expect(reopenedWorkspace.review).toMatchObject({
        id: submitted.reviewId,
        status: "reopened",
        revision: 2,
      });
    });
  });
});
