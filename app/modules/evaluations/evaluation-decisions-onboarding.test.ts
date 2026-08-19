import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { defaultRecommendationChoices } from "./evaluation-recommendation-choices";
import { EvaluationService } from "./evaluation-service.server";
import { ensureEvaluationDecisionTemplateFixture } from "./evaluation-test-fixtures";

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
    await ensureEvaluationDecisionTemplateFixture(
      env.DB,
      admin.eventId,
      admin.personId,
    );
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
            sessionTrackId: "demo-track-operations",
            sessionFormatKey: "presentation",
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
              sessionTrackId: "demo-track-operations",
              sessionFormatKey: "presentation",
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
            sessionTrackId: "demo-track-operations",
            sessionFormatKey: "presentation",
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
              recommendationChoices: defaultRecommendationChoices(),
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
            recommendationChoices: defaultRecommendationChoices(),
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
});
