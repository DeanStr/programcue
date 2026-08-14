import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  EvaluationRevisionConflictError,
  EvaluationService,
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

function evaluationEnvironment(base = env as unknown as CloudflareEnvironment) {
  return {
    ...base,
    OPERATIONS_QUEUE: { send: async () => undefined },
  } as unknown as CloudflareEnvironment;
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
          blindReviewVisibility:
            coreReviewVisibility === "reviewers" ? "content" : "identity",
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
          blindReviewVisibility:
            coreReviewVisibility === "reviewers" ? "content" : "identity",
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
          blindReviewVisibility:
            coreReviewVisibility === "reviewers" ? "content" : "identity",
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
          blindReviewVisibility: "content",
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

async function addRoundReviewer(
  roundId: string,
  personId = evaluator.personId,
) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO evaluation_round_reviewers
       (id, event_id, round_id, person_id, added_by_person_id)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      `test-round-reviewer-${roundId}-${personId}`,
      admin.eventId,
      roundId,
      personId,
      admin.personId,
    )
    .run();
}

describe("evaluation vertical slice", () => {
  beforeEach(async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM task_instances
          WHERE event_id = ? AND owner_person_id = 'person-sbek-speaker'`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `DELETE FROM memberships
          WHERE event_id = ? AND person_id = 'person-sbek-speaker'
            AND role = 'speaker'`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `UPDATE submission_speakers
            SET person_id = 'person-demo-submitter',
                email = 'alex.submitter@example.com',
                display_name = 'Alex Morgan'
          WHERE event_id = ? AND submission_id = 'eval-test-submission'`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `UPDATE people SET email = 'alex.submitter@example.com'
          WHERE id = 'person-demo-submitter'`,
      ),
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
      await addRoundReviewer(roundId);
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
});
