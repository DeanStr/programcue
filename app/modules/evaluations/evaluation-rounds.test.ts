import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { defaultRecommendationChoices } from "./evaluation-recommendation-choices";
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

async function insertAiAssessmentOperation(input: {
  id: string;
  eventId: string;
  roundId: string;
  status?: "running" | "completed";
}) {
  await env.DB.prepare(
    `INSERT INTO operation_jobs (
       id, organisation_id, event_id, requested_by_person_id, type,
       idempotency_key, correlation_id, status, payload_json,
       progress_total, progress_completed, attempt_count, cancellable,
       started_at, completed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'ai.review_assessment.generate', ?, ?, ?, ?,
               1, ?, 1, 0, unixepoch(), ?, unixepoch(), unixepoch())`,
  )
    .bind(
      input.id,
      admin.organisationId,
      input.eventId,
      admin.personId,
      input.id,
      input.id,
      input.status ?? "running",
      JSON.stringify({
        type: "ai.review_assessment.generate",
        generationIntentId: input.id,
        assessmentId: `assessment-${input.id}`,
        requestHash: "a".repeat(64),
        roundId: input.roundId,
        submissionId: "eval-test-submission",
        provider: "workers_ai",
        model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
        roundRevision: 1,
        scorecardId: input.roundId,
        scorecardVersion: 1,
        criterionIds: [criteria[0]!.id],
      }),
      input.status === "completed" ? 1 : 0,
      input.status === "completed" ? Math.floor(Date.now() / 1_000) : null,
    )
    .run();
}

async function insertOtherEvaluationEvent(eventId: string) {
  await env.DB.prepare(
    `INSERT INTO events (
       id, organisation_id, name, slug, timezone, starts_at, ends_at,
       file_policy_json
     ) VALUES (?, ?, 'Other evaluation event', ?, 'UTC', 2_000_000_000,
               2_000_086_400,
               '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')`,
  )
    .bind(eventId, admin.organisationId, eventId)
    .run();
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
        `INSERT OR IGNORE INTO submission_revisions
           (id, event_id, submission_id, form_version_id, revision_number,
            answers_json, speaker_snapshot_json, save_kind, saved_by_person_id)
         VALUES ('eval-test-submitted-revision', ?, 'eval-test-submission',
                 'eval-test-form-v1', 1, ?, '[]', 'submitted', 'person-demo-submitter')`,
      ).bind(
        admin.eventId,
        JSON.stringify({
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
            recommendationChoices: defaultRecommendationChoices(),
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
              recommendationChoices: defaultRecommendationChoices(),
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

    it("preserves AI assessments when plan replacement races the activity check", async () => {
      await resetEvaluationFixture();
      const testEnv = env as unknown as CloudflareEnvironment;
      const service = new EvaluationService(testEnv);
      const roundId = "eval-ai-guard-round";
      const replacementRoundId = "eval-ai-guard-replacement-round";
      const assessmentId = "eval-ai-plan-replacement-assessment";
      await service.savePlan(admin, {
        revision: 0,
        name: "AI-assessed plan",
        status: "active",
        rounds: [
          {
            id: roundId,
            name: "Original AI-assessed round",
            anonymous: false,
            recommendationChoices: defaultRecommendationChoices(),
            criteria,
          },
        ],
      });
      const replacement = {
        revision: 1,
        name: "Unsafe AI replacement",
        status: "active" as const,
        rounds: [
          {
            id: replacementRoundId,
            name: "Replacement round",
            anonymous: false,
            recommendationChoices: defaultRecommendationChoices(),
            criteria: criteria.map((criterion) => ({
              ...criterion,
              id: `${criterion.id}-ai-replacement`,
            })),
          },
        ],
      };
      const racingEnv = withBatchRace(testEnv, async () => {
        await testEnv.DB.prepare(
          `INSERT INTO ai_review_assessments (
             id, event_id, round_id, submission_id, scorecard_id,
             scorecard_version, round_revision, score, rationale, provider,
             model, provider_response_id, generated_by_person_id,
             last_operation_id, submission_revision_id, source_snapshot_sha256,
             model_input_sha256, prompt_version
           ) VALUES (?, ?, ?, 'eval-test-submission', ?, 1, 1, 4,
                     'This persisted AI assessment must survive a concurrent plan replacement attempt.',
                     'workers_ai', '@cf/deepseek-ai/deepseek-v4-flash-0731', ?, ?, ?,
                     'eval-test-submitted-revision', ?, ?, 1)`,
        )
          .bind(
            assessmentId,
            admin.eventId,
            roundId,
            roundId,
            "eval-ai-plan-replacement-response",
            admin.personId,
            "eval-ai-plan-replacement-operation",
            "a".repeat(64),
            "b".repeat(64),
          )
          .run();
      });

      await expect(
        new EvaluationService(racingEnv).savePlan(admin, replacement),
      ).rejects.toThrow(/plan with AI assessments cannot/i);
      await expect(service.savePlan(admin, replacement)).rejects.toThrow(
        /plan with AI assessments cannot/i,
      );

      const state = await testEnv.DB.prepare(
        `SELECT plan.name, plan.revision,
                (SELECT COUNT(*) FROM evaluation_rounds current_round
                  WHERE current_round.plan_id = plan.id
                    AND current_round.id = ?) AS originalRoundCount,
                (SELECT COUNT(*) FROM evaluation_rounds replacement_round
                  WHERE replacement_round.plan_id = plan.id
                    AND replacement_round.id = ?) AS replacementRoundCount,
                (SELECT COUNT(*) FROM ai_review_assessments assessment
                  WHERE assessment.id = ? AND assessment.event_id = plan.event_id
                    AND assessment.round_id = ?) AS assessmentCount
           FROM evaluation_plans plan
          WHERE plan.event_id = ? AND plan.status <> 'archived'`,
      )
        .bind(roundId, replacementRoundId, assessmentId, roundId, admin.eventId)
        .first<{
          name: string;
          revision: number;
          originalRoundCount: number;
          replacementRoundCount: number;
          assessmentCount: number;
        }>();
      expect(state).toEqual({
        name: "AI-assessed plan",
        revision: 1,
        originalRoundCount: 1,
        replacementRoundCount: 0,
        assessmentCount: 1,
      });
    });

    it("blocks a running AI operation that races plan replacement", async () => {
      await resetEvaluationFixture();
      const testEnv = env as unknown as CloudflareEnvironment;
      const service = new EvaluationService(testEnv);
      const token = crypto.randomUUID();
      const roundId = `eval-ai-running-plan-round-${token}`;
      const replacementRoundId = `eval-ai-running-plan-replacement-${token}`;
      const operationId = crypto.randomUUID();
      await service.savePlan(admin, {
        revision: 0,
        name: "Stable AI generation plan",
        status: "active",
        rounds: [
          {
            id: roundId,
            name: "Original AI generation round",
            anonymous: false,
            recommendationChoices: defaultRecommendationChoices(),
            criteria,
          },
        ],
      });
      const replacement = {
        revision: 1,
        name: "Unsafe running-AI replacement",
        status: "active" as const,
        rounds: [
          {
            id: replacementRoundId,
            name: "Replacement round",
            anonymous: false,
            recommendationChoices: defaultRecommendationChoices(),
            criteria: criteria.map((criterion) => ({
              ...criterion,
              id: `${criterion.id}-${token}-replacement`,
            })),
          },
        ],
      };
      let raceInjected = false;
      const racingEnv = withBatchRace(testEnv, async () => {
        raceInjected = true;
        await insertAiAssessmentOperation({
          id: operationId,
          eventId: admin.eventId,
          roundId,
        });
      });

      try {
        await expect(
          new EvaluationService(racingEnv).savePlan(admin, replacement),
        ).rejects.toThrow(/running AI review assessment appeared/i);
        expect(raceInjected).toBe(true);
        await expect(service.savePlan(admin, replacement)).rejects.toThrow(
          /running AI review assessment/i,
        );

        const state = await testEnv.DB.prepare(
          `SELECT plan.name, plan.revision,
                  (SELECT COUNT(*) FROM evaluation_rounds current_round
                    WHERE current_round.plan_id = plan.id
                      AND current_round.id = ?) AS originalRoundCount,
                  (SELECT COUNT(*) FROM evaluation_rounds replacement_round
                    WHERE replacement_round.plan_id = plan.id
                      AND replacement_round.id = ?) AS replacementRoundCount
             FROM evaluation_plans plan
            WHERE plan.event_id = ? AND plan.status <> 'archived'`,
        )
          .bind(roundId, replacementRoundId, admin.eventId)
          .first();
        expect(state).toEqual({
          name: "Stable AI generation plan",
          revision: 1,
          originalRoundCount: 1,
          replacementRoundCount: 0,
        });
      } finally {
        await testEnv.DB.prepare("DELETE FROM operation_jobs WHERE id = ?")
          .bind(operationId)
          .run();
      }
    });

    it("ignores terminal, unrelated and other-event AI operations during plan replacement", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const token = crypto.randomUUID();
      const roundId = `eval-ai-plan-scope-round-${token}`;
      const replacementRoundId = `eval-ai-plan-scope-replacement-${token}`;
      const otherEventId = `eval-ai-plan-scope-event-${token}`;
      const completedOperationId = crypto.randomUUID();
      const unrelatedOperationId = crypto.randomUUID();
      const otherEventOperationId = crypto.randomUUID();
      await service.savePlan(admin, {
        revision: 0,
        name: "Scoped AI plan",
        status: "active",
        rounds: [
          {
            id: roundId,
            name: "Scoped round",
            anonymous: false,
            recommendationChoices: defaultRecommendationChoices(),
            criteria,
          },
        ],
      });
      await insertOtherEvaluationEvent(otherEventId);
      await insertAiAssessmentOperation({
        id: completedOperationId,
        eventId: admin.eventId,
        roundId,
        status: "completed",
      });
      await insertAiAssessmentOperation({
        id: unrelatedOperationId,
        eventId: admin.eventId,
        roundId: `missing-round-${token}`,
      });
      await insertAiAssessmentOperation({
        id: otherEventOperationId,
        eventId: otherEventId,
        roundId,
      });

      try {
        await expect(
          service.savePlan(admin, {
            revision: 1,
            name: "Safely replaced scoped AI plan",
            status: "active",
            rounds: [
              {
                id: replacementRoundId,
                name: "Safe replacement round",
                anonymous: false,
                recommendationChoices: defaultRecommendationChoices(),
                criteria: criteria.map((criterion) => ({
                  ...criterion,
                  id: `${criterion.id}-${token}-safe-replacement`,
                })),
              },
            ],
          }),
        ).resolves.toBeTruthy();
      } finally {
        await env.DB.prepare("DELETE FROM operation_jobs WHERE id IN (?, ?, ?)")
          .bind(
            completedOperationId,
            unrelatedOperationId,
            otherEventOperationId,
          )
          .run();
        await env.DB.prepare("DELETE FROM events WHERE id = ?")
          .bind(otherEventId)
          .run();
      }
    });
  });

  describe("round workflows", () => {
    it("blocks running AI operations that race round edits and deletions", async () => {
      await resetEvaluationFixture();
      const testEnv = env as unknown as CloudflareEnvironment;
      const service = new EvaluationService(testEnv);
      const token = crypto.randomUUID();
      const firstRoundId = `eval-ai-round-guard-first-${token}`;
      const guardedRoundId = `eval-ai-round-guard-draft-${token}`;
      await service.savePlan(admin, {
        revision: 0,
        name: "AI round mutation guards",
        status: "active",
        rounds: [
          {
            id: firstRoundId,
            name: "Active review",
            anonymous: false,
            recommendationChoices: defaultRecommendationChoices(),
            criteria,
          },
          {
            id: guardedRoundId,
            name: "Guarded draft review",
            anonymous: false,
            recommendationChoices: defaultRecommendationChoices(),
            criteria: criteria.map((criterion) => ({
              ...criterion,
              id: `${criterion.id}-${token}-draft`,
            })),
          },
        ],
      });
      const initialWorkspace = await service.getAdminWorkspace(admin);
      const guardedRound = initialWorkspace.plan!.rounds.find(
        (round) => round.id === guardedRoundId,
      )!;
      const editOperationId = crypto.randomUUID();
      const editRace = withBatchRace(testEnv, () =>
        insertAiAssessmentOperation({
          id: editOperationId,
          eventId: admin.eventId,
          roundId: guardedRoundId,
        }),
      );
      const editInput = {
        roundId: guardedRoundId,
        revision: guardedRound.revision,
        name: "Unsafe edited draft review",
        dueAt: null,
        recommendationChoices: guardedRound.recommendationChoices,
        criteria: guardedRound.criteria.map((criterion) => ({
          ...criterion,
          description: criterion.description ?? "",
        })),
      };

      try {
        await expect(
          new EvaluationService(editRace).updateDraftRound(admin, editInput),
        ).rejects.toThrow(/running AI review assessment appeared/i);
        await expect(
          service.updateDraftRound(admin, editInput),
        ).rejects.toThrow(/running AI-assessment activity/i);
        expect(
          (await service.getAdminWorkspace(admin)).plan!.rounds.find(
            (round) => round.id === guardedRoundId,
          ),
        ).toMatchObject({
          name: "Guarded draft review",
          runningAiAssessmentCount: 1,
        });
      } finally {
        await testEnv.DB.prepare("DELETE FROM operation_jobs WHERE id = ?")
          .bind(editOperationId)
          .run();
      }

      const refreshed = await service.getAdminWorkspace(admin);
      const deletableRound = refreshed.plan!.rounds.find(
        (round) => round.id === guardedRoundId,
      )!;
      const deleteOperationId = crypto.randomUUID();
      const deleteRace = withBatchRace(testEnv, () =>
        insertAiAssessmentOperation({
          id: deleteOperationId,
          eventId: admin.eventId,
          roundId: guardedRoundId,
        }),
      );
      const deleteInput = {
        roundId: guardedRoundId,
        roundRevision: deletableRound.revision,
        planRevision: refreshed.plan!.revision,
        expectedReviewerPersonIds: [],
        confirmed: true,
      };

      try {
        await expect(
          new EvaluationService(deleteRace).deleteDraftRound(
            admin,
            deleteInput,
          ),
        ).rejects.toThrow(/running AI review assessment appeared/i);
        await expect(
          service.deleteDraftRound(admin, deleteInput),
        ).rejects.toThrow(/running AI review assessment/i);
        await expect(
          testEnv.DB.prepare(
            "SELECT name FROM evaluation_rounds WHERE id = ? AND event_id = ?",
          )
            .bind(guardedRoundId, admin.eventId)
            .first(),
        ).resolves.toEqual({ name: "Guarded draft review" });
      } finally {
        await testEnv.DB.prepare("DELETE FROM operation_jobs WHERE id = ?")
          .bind(deleteOperationId)
          .run();
      }
    });

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
            recommendationChoices: defaultRecommendationChoices(),
            criteria,
          },
        ],
      });
      const nextRoundId = await service.addNextRound(admin, {
        planId,
        planRevision: 1,
        name: "Final review draft",
        opensAt: "2026-08-11T09:00:00.000Z",
        closesAt: "2099-12-31T17:00:00.000Z",
        dueAt: null,
        cloneRoundId: "eval-multi-round-one",
      });
      const configuredOpeningTime = Math.floor(
        Date.parse("2026-08-11T09:00:00.000Z") / 1_000,
      );
      await addRoundReviewer("eval-multi-round-one");
      await addRoundReviewer(nextRoundId);
      const nextRound = (
        await service.getAdminWorkspace(admin)
      ).plan!.rounds.find((round) => round.id === nextRoundId)!;
      const draftRoundUpdate = {
        roundId: nextRoundId,
        revision: 1,
        name: "Final review",
        dueAt: null,
        recommendationChoices: nextRound.recommendationChoices,
        criteria: nextRound.criteria.map((criterion) => ({
          ...criterion,
          description: criterion.description ?? "",
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
      const submitted = await service.saveReview(
        evaluator,
        {
          assignmentId: firstWorkspace.selected!.id,
          revision: 0,
          scores: Object.fromEntries(
            firstWorkspace.criteria.map((criterion) => [criterion.id, 5]),
          ),
          recommendation: "accept",
          confidence: 5,
          submitterFeedback: "Strong proposal.",
          privateNotes: "Advance to the final round.",
          conflictAffirmed: true,
          intent: "submit",
        },
        "participant_ui",
      );
      const nonAdvancedWorkspace = await service.getReviewerWorkspace(
        evaluator,
        queue.assignments.find(
          (assignment) =>
            assignment.submissionId === "eval-multi-round-not-advanced",
        )!.id,
      );
      await service.saveReview(
        evaluator,
        {
          assignmentId: nonAdvancedWorkspace.selected!.id,
          revision: 0,
          scores: Object.fromEntries(
            nonAdvancedWorkspace.criteria.map((criterion) => [criterion.id, 3]),
          ),
          recommendation: "reject",
          confidence: 4,
          submitterFeedback: "Not selected for the final round.",
          privateNotes: "Conclude after the first round.",
          conflictAffirmed: true,
          intent: "submit",
        },
        "participant_ui",
      );

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
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO sessions (
             id, event_id, source_submission_id, title, slug, description,
             format, duration_minutes, status, revision, created_at, updated_at
           ) VALUES (
             'eval-multi-round-stale-session', ?, 'eval-test-submission',
             'Stale direct review target', 'eval-multi-round-stale-session',
             'This assignment becomes historical before advancement.',
             'presentation', 45, 'unscheduled', 1, unixepoch(), unixepoch()
           )`,
        ).bind(admin.eventId),
        env.DB.prepare(
          `INSERT INTO evaluator_assignments (
             id, event_id, round_id, session_id, session_snapshot_json,
             evaluator_person_id, status, revision, assigned_at
           ) VALUES (
             'eval-multi-round-stale-session-assignment', ?,
             'eval-multi-round-one', 'eval-multi-round-stale-session', '{}',
             ?, 'assigned', 1, unixepoch()
           )`,
        ).bind(admin.eventId, evaluator.personId),
      ]);
      await expect(
        service.advanceRound(admin, advanceInput),
      ).rejects.toBeInstanceOf(EvaluationRevisionConflictError);
      await env.DB.prepare(
        `UPDATE sessions SET status = 'cancelled', revision = revision + 1
          WHERE id = 'eval-multi-round-stale-session' AND event_id = ?`,
      )
        .bind(admin.eventId)
        .run();
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
          (SELECT opens_at FROM evaluation_rounds WHERE id = ?) AS secondOpensAt,
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
              AND submission_id = 'eval-multi-round-not-advanced') AS nonAdvancedAssignmentCount,
          (SELECT status FROM evaluator_assignments
              WHERE id = 'eval-multi-round-stale-session-assignment') AS staleAssignmentStatus,
          (SELECT status FROM sessions
              WHERE id = 'eval-multi-round-stale-session') AS staleSessionStatus
      `,
      )
        .bind(
          nextRoundId,
          nextRoundId,
          submitted.reviewId,
          nextRoundId,
          nextRoundId,
        )
        .first();
      expect(state).toEqual({
        firstStatus: "closed",
        secondStatus: "active",
        secondOpensAt: configuredOpeningTime,
        reviewStatus: "locked",
        submissionStatus: "assigned",
        nonAdvancedSubmissionStatus: "decision_ready",
        nextAssignmentCount: 1,
        nonAdvancedAssignmentCount: 0,
        staleAssignmentStatus: "assigned",
        staleSessionStatus: "cancelled",
      });
      const nextWorkspace = await service.getReviewerWorkspace(evaluator);
      expect(nextWorkspace.selected).toMatchObject({
        submissionId: "eval-test-submission",
        status: "assigned",
      });
    });

    it("fails closed when a recused reviewer is still in the advance pool", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const planId = await service.savePlan(admin, {
        revision: 0,
        name: "Recusal-guarded advance plan",
        status: "active",
        rounds: [
          {
            id: "eval-advance-recusal-one",
            name: "Initial review",
            anonymous: false,
            recommendationChoices: defaultRecommendationChoices(),
            criteria,
          },
        ],
      });
      const nextRoundId = await service.addNextRound(admin, {
        planId,
        planRevision: 1,
        name: "Final review",
        opensAt: null,
        closesAt: null,
        dueAt: null,
        cloneRoundId: "eval-advance-recusal-one",
      });
      await addRoundReviewer("eval-advance-recusal-one");
      await addRoundReviewer(nextRoundId);
      await service.assign(admin, {
        roundId: "eval-advance-recusal-one",
        targetType: "submission",
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
      });
      const workspace = await service.getReviewerWorkspace(evaluator);
      await service.saveReview(
        evaluator,
        {
          assignmentId: workspace.selected!.id,
          revision: 0,
          scores: Object.fromEntries(
            workspace.criteria.map((criterion) => [criterion.id, 5]),
          ),
          recommendation: "accept",
          confidence: 5,
          submitterFeedback: "Advance this proposal.",
          privateNotes: "No remaining conflict after the first round.",
          conflictAffirmed: true,
          intent: "submit",
        },
        "participant_ui",
      );
      await env.DB.prepare(
        `INSERT INTO evaluator_assignments (
           id, event_id, round_id, submission_id, evaluator_person_id,
           status, revision, assigned_at
         ) VALUES (
           'eval-advance-recused-pair', ?, ?, 'eval-test-submission', ?,
           'recused', 1, unixepoch()
         )`,
      )
        .bind(admin.eventId, nextRoundId, evaluator.personId)
        .run();

      await expect(
        service.advanceRound(admin, {
          fromRoundId: "eval-advance-recusal-one",
          fromRoundRevision: 1,
          toRoundId: nextRoundId,
          toRoundRevision: 1,
          submissionIds: ["eval-test-submission"],
          evaluatorPersonIds: [evaluator.personId],
          teamId: null,
          confirmed: true,
        }),
      ).rejects.toBeInstanceOf(EvaluationRevisionConflictError);
      expect(
        await env.DB.prepare(
          `
          SELECT
            (SELECT status FROM evaluation_rounds
              WHERE id = 'eval-advance-recusal-one') AS firstStatus,
            (SELECT status FROM evaluation_rounds WHERE id = ?) AS secondStatus,
            (SELECT COUNT(*) FROM evaluator_assignments
              WHERE round_id = ? AND submission_id = 'eval-test-submission'
                AND status = 'assigned') AS nextAssignedCount
        `,
        )
          .bind(nextRoundId, nextRoundId)
          .first(),
      ).toEqual({
        firstStatus: "active",
        secondStatus: "draft",
        nextAssignedCount: 0,
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
            recommendationChoices: defaultRecommendationChoices(),
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
      await addRoundReviewer("eval-moderation-round");
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
      const submitted = await service.saveReview(
        evaluator,
        {
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
          conflictAffirmed: true,
          intent: "submit",
        },
        "participant_ui",
      );
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

      const draftModerationId = await service.moderate(
        admin,
        {
          roundId: "eval-moderation-round",
          submissionId: "eval-test-submission",
          expectedModerationId: null,
          recommendation: "advance",
          moderatedScore: 4.75,
          notes: "The panel agrees this proposal should advance.",
          status: "draft",
          confirmed: false,
        },
        "admin_ui",
      );
      const confirmedModerationId = await service.moderate(
        admin,
        {
          roundId: "eval-moderation-round",
          submissionId: "eval-test-submission",
          expectedModerationId: draftModerationId,
          recommendation: "advance",
          moderatedScore: 4.75,
          notes: "The panel confirmed this outcome.",
          status: "confirmed",
          confirmed: true,
        },
        "admin_ui",
      );
      expect(confirmedModerationId).not.toBe(draftModerationId);

      const reopened = await service.reopenReview(
        admin,
        {
          assignmentId: reviewerWorkspace.selected!.id,
          reason: "The evaluator must correct a material factual error.",
          confirmed: true,
        },
        "admin_ui",
      );
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
