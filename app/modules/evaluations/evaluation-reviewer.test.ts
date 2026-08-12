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
              form_version_id = 'eval-test-form-v1', category = 'Operations',
              format = 'Presentation', answers_json = ?,
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
});
