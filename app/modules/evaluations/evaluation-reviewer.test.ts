import { env } from "cloudflare:test";

import { beforeEach, describe, expect, it } from "vitest";

import type { AiModelProvider } from "~/modules/ai/openai-responses-provider.server";

import { ReviewerAiSuggestionService } from "~/modules/ai/reviewer-ai-suggestion.server";

import { ensureDemoData } from "~/platform/demo/seed.server";

import { defaultRecommendationChoices } from "./evaluation-recommendation-choices";
import {
  addReviewWebhookEndpoint,
  addRoundReviewer,
  admin,
  completeReviewInput,
  conflictBatchState,
  criteria,
  evaluationEnvironment,
  evaluator,
  moderationBatchState,
  prepareReviewerAiGenerationFixture,
  resetEvaluationFixture,
  reviewBatchState,
  submittedSnapshot,
  successfulReviewerAiProvider,
  withBatchRace,
  withMissingFirstResult,
  withSuppressedStatement,
} from "./evaluation-reviewer.test-support";
import {
  EvaluationService,
  EvaluationValidationError,
} from "./evaluation-service.server";

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
    it("fails fast for reviewer AI on Airtable-authoritative events", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      let providerCalls = 0;
      const provider: AiModelProvider = {
        providerName: "Workers AI",
        model: "must-not-run",
        async create() {
          providerCalls += 1;
          throw new Error("Provider must not run for an Airtable event.");
        },
      };
      const ai = new ReviewerAiSuggestionService(testEnv, { provider });
      await env.DB.prepare(
        "UPDATE events SET repository_provider = 'airtable' WHERE id = ?",
      )
        .bind(admin.eventId)
        .run();
      try {
        await expect(ai.setting(evaluator)).resolves.toMatchObject({
          enabled: false,
          supported: false,
        });
        await expect(
          ai.updateSetting(admin, { enabled: true, revision: 0 }),
        ).rejects.toThrow(/authoritative repository/i);
        await expect(
          ai.generate(evaluator, { assignmentId: "unavailable-assignment" }),
        ).rejects.toThrow(/authoritative repository/i);
        expect(providerCalls).toBe(0);
      } finally {
        await env.DB.prepare(
          "UPDATE events SET repository_provider = 'd1' WHERE id = ?",
        )
          .bind(admin.eventId)
          .run();
      }
    });

    it.each(["disablement", "recusal"] as const)(
      "revalidates reviewer AI %s at the provider-call boundary",
      async (race) => {
        const { assignmentId, service, testEnv } =
          await prepareReviewerAiGenerationFixture(
            `eval-ai-boundary-${race}-round`,
          );
        let providerCalls = 0;
        const provider: AiModelProvider = {
          providerName: "Workers AI",
          model: "must-not-run",
          async create() {
            providerCalls += 1;
            throw new Error(
              "Provider must not run after reviewer access changes.",
            );
          },
        };
        const racingEnv = withBatchRace(testEnv, async () => {
          if (race === "disablement") {
            await new ReviewerAiSuggestionService(testEnv).updateSetting(
              admin,
              {
                enabled: false,
                revision: 1,
              },
            );
            return;
          }
          await service.declareConflict(
            evaluator,
            {
              assignmentId,
              reason: "A concurrent conflict declaration requires recusal.",
            },
            "participant_ui",
          );
        });

        try {
          await expect(
            new ReviewerAiSuggestionService(racingEnv, { provider }).generate(
              evaluator,
              { assignmentId },
            ),
          ).rejects.toThrow(/could not start/i);
          expect(providerCalls).toBe(0);
          expect(
            await env.DB.prepare(
              `SELECT COUNT(*) AS count FROM operation_jobs
                WHERE event_id = ?
                  AND type = 'ai.reviewer_suggestion.generate'
                  AND status = 'running'
                  AND json_extract(payload_json, '$.assignmentId') = ?`,
            )
              .bind(evaluator.eventId, assignmentId)
              .first<{ count: number }>(),
          ).toEqual({ count: 0 });
        } finally {
          await resetEvaluationFixture();
        }
      },
    );

    it("rolls back a reviewer AI setting when its audit insertion is suppressed", async () => {
      await resetEvaluationFixture();
      const testEnv = env as unknown as CloudflareEnvironment;
      const fault = withSuppressedStatement(
        testEnv,
        /INSERT INTO audit_events[\s\S]*evaluation\.reviewer_ai_setting\.updated/u,
      );

      await expect(
        new ReviewerAiSuggestionService(fault.env).updateSetting(admin, {
          enabled: true,
          revision: 0,
        }),
      ).rejects.toThrow();
      expect(fault.suppressed()).toBe(1);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM event_ai_review_settings WHERE event_id = ?",
        )
          .bind(admin.eventId)
          .first(),
      ).toEqual({ count: 0 });
    });

    it("rolls back a reviewer AI request when its requested audit is suppressed", async () => {
      const { assignmentId, testEnv } =
        await prepareReviewerAiGenerationFixture("eval-ai-request-audit-round");
      let providerCalls = 0;
      const fault = withSuppressedStatement(
        testEnv,
        /INSERT INTO audit_events[\s\S]*ai\.reviewer_suggestion\.requested/u,
      );

      await expect(
        new ReviewerAiSuggestionService(fault.env, {
          provider: successfulReviewerAiProvider(() => {
            providerCalls += 1;
          }),
        }).generate(evaluator, { assignmentId }),
      ).rejects.toThrow(/audit evidence/i);
      expect(fault.suppressed()).toBe(1);
      expect(providerCalls).toBe(0);
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM operation_jobs
            WHERE event_id = ? AND type = 'ai.reviewer_suggestion.generate'
              AND json_extract(payload_json, '$.assignmentId') = ?`,
        )
          .bind(evaluator.eventId, assignmentId)
          .first(),
      ).toEqual({ count: 0 });
      await resetEvaluationFixture();
    });

    it.each([
      ["immutable revision", /INSERT INTO review_revisions/u],
      [
        "success audit",
        /INSERT INTO audit_events \(id, actor_kind, origin,[\s\S]*'review', \?, \?, \?, unixepoch\(\)/u,
      ],
    ])(
      "rolls back a review save when its %s is suppressed",
      async (_evidence, pattern) => {
        const { assignmentId, initialReview, testEnv } =
          await prepareReviewerAiGenerationFixture(
            `eval-review-atomic-${crypto.randomUUID()}`,
          );
        const before = await reviewBatchState(assignmentId);
        const fault = withSuppressedStatement(testEnv, pattern);

        await expect(
          new EvaluationService(fault.env).saveReview(
            evaluator,
            completeReviewInput(assignmentId, initialReview.revision, "save"),
            "participant_ui",
          ),
        ).rejects.toThrow(/complete revision, audit, and delivery evidence/i);

        expect(fault.suppressed()).toBe(1);
        expect(await reviewBatchState(assignmentId)).toEqual(before);
        await resetEvaluationFixture();
      },
    );

    it("rolls back a review save when its AI import transition is suppressed", async () => {
      const { assignmentId, initialReview, testEnv } =
        await prepareReviewerAiGenerationFixture(
          `eval-review-ai-import-atomic-${crypto.randomUUID()}`,
        );
      const ai = new ReviewerAiSuggestionService(testEnv, {
        provider: successfulReviewerAiProvider(),
      });
      const suggestion = await ai.generate(evaluator, { assignmentId });
      const importedCriterionIds = criteria
        .map((criterion) => criterion.id)
        .filter((criterionId) => criterionId !== "eval-test-relevance");
      const before = await reviewBatchState(assignmentId);
      const suggestionBefore = await env.DB.prepare(
        `SELECT status, imported_at AS importedAt,
                lifecycle_operation_id AS operationId
           FROM reviewer_ai_suggestions WHERE id = ?`,
      )
        .bind(suggestion.id)
        .first();
      const fault = withSuppressedStatement(
        testEnv,
        /UPDATE reviewer_ai_suggestions AS suggestion[\s\S]*SET status = 'imported'/u,
      );

      await expect(
        new EvaluationService(fault.env).saveReview(
          evaluator,
          {
            ...completeReviewInput(
              assignmentId,
              initialReview.revision,
              "save",
            ),
            scores: Object.fromEntries(
              criteria.map((criterion) => [
                criterion.id,
                criterion.id === "eval-test-relevance" ? 3 : 4,
              ]),
            ),
            suggestionId: suggestion.id,
            importedCriterionIds,
          },
          "participant_ui",
        ),
      ).rejects.toThrow();

      expect(fault.suppressed()).toBe(1);
      expect(await reviewBatchState(assignmentId)).toEqual(before);
      expect(
        await env.DB.prepare(
          `SELECT status, imported_at AS importedAt,
                  lifecycle_operation_id AS operationId
             FROM reviewer_ai_suggestions WHERE id = ?`,
        )
          .bind(suggestion.id)
          .first(),
      ).toEqual(suggestionBefore);
      await resetEvaluationFixture();
    });

    it("rolls back a review submission when one expected webhook row is suppressed", async () => {
      const { assignmentId, initialReview, testEnv } =
        await prepareReviewerAiGenerationFixture(
          `eval-review-webhook-atomic-${crypto.randomUUID()}`,
        );
      const endpointId = await addReviewWebhookEndpoint("review.submitted");
      const before = await reviewBatchState(assignmentId);
      const fault = withSuppressedStatement(
        evaluationEnvironment(testEnv),
        /INSERT INTO operation_items/u,
      );

      try {
        await expect(
          new EvaluationService(fault.env).saveReview(
            evaluator,
            completeReviewInput(assignmentId, initialReview.revision, "submit"),
            "participant_ui",
          ),
        ).rejects.toThrow(/complete revision, audit, and delivery evidence/i);
        expect(fault.suppressed()).toBe(1);
        expect(await reviewBatchState(assignmentId)).toEqual(before);
        expect(
          await env.DB.prepare(
            "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE endpoint_id = ?",
          )
            .bind(endpointId)
            .first(),
        ).toEqual({ count: 0 });
      } finally {
        await env.DB.prepare("DELETE FROM webhook_endpoints WHERE id = ?")
          .bind(endpointId)
          .run();
        await resetEvaluationFixture();
      }
    });

    it.each([
      ["immutable revision", /INSERT INTO review_revisions/u],
      ["success audit", /INSERT INTO audit_events[\s\S]*'review\.reopened'/u],
      ["webhook operation item", /INSERT INTO operation_items/u],
    ])(
      "rolls back review reopen when its %s is suppressed",
      async (_evidence, pattern) => {
        const { assignmentId, initialReview, service, testEnv } =
          await prepareReviewerAiGenerationFixture(
            `eval-reopen-atomic-${crypto.randomUUID()}`,
          );
        await service.saveReview(
          evaluator,
          completeReviewInput(assignmentId, initialReview.revision, "submit"),
          "participant_ui",
        );
        const endpointId = await addReviewWebhookEndpoint("review.reopened");
        const before = await reviewBatchState(assignmentId);
        const fault = withSuppressedStatement(
          evaluationEnvironment(testEnv),
          pattern,
        );

        try {
          await expect(
            new EvaluationService(fault.env).reopenReview(
              admin,
              {
                assignmentId,
                reason: "The reviewer must correct material evidence.",
                confirmed: true,
              },
              "admin_ui",
            ),
          ).rejects.toThrow(/complete revision, audit, and delivery evidence/i);
          expect(fault.suppressed()).toBe(1);
          expect(await reviewBatchState(assignmentId)).toEqual(before);
          expect(
            await env.DB.prepare(
              "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE endpoint_id = ?",
            )
              .bind(endpointId)
              .first(),
          ).toEqual({ count: 0 });
        } finally {
          await env.DB.prepare("DELETE FROM webhook_endpoints WHERE id = ?")
            .bind(endpointId)
            .run();
          await resetEvaluationFixture();
        }
      },
    );

    it.each([
      ["replacement moderation", /INSERT INTO review_moderations/u],
      [
        "success audit",
        /INSERT INTO audit_events \([\s\S]*'review_moderation'/u,
      ],
      [
        "confirmed submission transition",
        /UPDATE submissions SET status = 'decision_ready'/u,
      ],
    ])(
      "rolls back moderation when its %s is suppressed",
      async (_evidence, pattern) => {
        const { assignmentId, initialReview, service, testEnv } =
          await prepareReviewerAiGenerationFixture(
            `eval-moderation-atomic-${crypto.randomUUID()}`,
          );
        await service.saveReview(
          evaluator,
          completeReviewInput(assignmentId, initialReview.revision, "submit"),
          "participant_ui",
        );
        const assignment = await testEnv.DB.prepare(
          `SELECT round_id AS roundId, submission_id AS submissionId
             FROM evaluator_assignments WHERE id = ? AND event_id = ?`,
        )
          .bind(assignmentId, evaluator.eventId)
          .first<{ roundId: string; submissionId: string }>();
        const draftModerationId = await service.moderate(
          admin,
          {
            roundId: assignment!.roundId,
            submissionId: assignment!.submissionId,
            expectedModerationId: null,
            recommendation: "advance",
            moderatedScore: 4,
            notes: "Draft moderation evidence.",
            status: "draft",
            confirmed: false,
          },
          "admin_ui",
        );
        const before = await moderationBatchState(
          assignment!.roundId,
          assignment!.submissionId,
        );
        const fault = withSuppressedStatement(testEnv, pattern);

        await expect(
          new EvaluationService(fault.env).moderate(
            admin,
            {
              roundId: assignment!.roundId,
              submissionId: assignment!.submissionId,
              expectedModerationId: draftModerationId,
              recommendation: "advance",
              moderatedScore: 4,
              notes: "Confirmed moderation evidence.",
              status: "confirmed",
              confirmed: true,
            },
            "admin_ui",
          ),
        ).rejects.toThrow(/complete state and audit evidence/i);

        expect(fault.suppressed()).toBe(1);
        expect(
          await moderationBatchState(
            assignment!.roundId,
            assignment!.submissionId,
          ),
        ).toEqual(before);
        await resetEvaluationFixture();
      },
    );

    it.each([
      ["conflict record", /INSERT INTO evaluator_conflicts/u],
      [
        "success audit",
        /INSERT INTO audit_events[\s\S]*'review\.conflict\.declared'/u,
      ],
    ])(
      "rolls back conflict declaration when its %s is suppressed",
      async (_evidence, pattern) => {
        const { assignmentId, testEnv } =
          await prepareReviewerAiGenerationFixture(
            `eval-conflict-atomic-${crypto.randomUUID()}`,
          );
        const before = await conflictBatchState(assignmentId);
        const fault = withSuppressedStatement(testEnv, pattern);

        await expect(
          new EvaluationService(fault.env).declareConflict(
            evaluator,
            {
              assignmentId,
              reason: "A material relationship prevents impartial review.",
            },
            "participant_ui",
          ),
        ).rejects.toThrow(/complete recusal and audit evidence/i);

        expect(fault.suppressed()).toBe(1);
        expect(await conflictBatchState(assignmentId)).toEqual(before);
        await resetEvaluationFixture();
      },
    );

    it("updates and guards the exact existing conflict record", async () => {
      const { assignmentId, service, testEnv } =
        await prepareReviewerAiGenerationFixture(
          `eval-conflict-existing-${crypto.randomUUID()}`,
        );
      const assignment = await testEnv.DB.prepare(
        `SELECT round_id AS roundId, submission_id AS submissionId
           FROM evaluator_assignments WHERE id = ? AND event_id = ?`,
      )
        .bind(assignmentId, evaluator.eventId)
        .first<{ roundId: string; submissionId: string }>();
      const existingConflictId = `existing-conflict-${crypto.randomUUID()}`;
      await testEnv.DB.prepare(
        `INSERT INTO evaluator_conflicts (
           id, event_id, round_id, submission_id, evaluator_person_id,
           relationship, notes, status, declared_at
         ) VALUES (?, ?, ?, ?, ?, 'declared', ?, 'declared', unixepoch())`,
      )
        .bind(
          existingConflictId,
          evaluator.eventId,
          assignment!.roundId,
          assignment!.submissionId,
          evaluator.personId,
          "Earlier disclosure awaiting recusal.",
        )
        .run();

      await service.declareConflict(
        evaluator,
        {
          assignmentId,
          reason: "The confirmed relationship prevents impartial review.",
        },
        "participant_ui",
      );

      expect(
        await testEnv.DB.prepare(
          `SELECT id, notes, status FROM evaluator_conflicts
            WHERE round_id = ? AND submission_id = ?
              AND evaluator_person_id = ?`,
        )
          .bind(
            assignment!.roundId,
            assignment!.submissionId,
            evaluator.personId,
          )
          .first(),
      ).toEqual({
        id: existingConflictId,
        notes: "The confirmed relationship prevents impartial review.",
        status: "recused",
      });
      await resetEvaluationFixture();
    });

    it("returns an assignment for a typed non-conflict reason without creating a conflict", async () => {
      const { assignmentId, initialReview, service, testEnv } =
        await prepareReviewerAiGenerationFixture(
          `eval-abstention-${crypto.randomUUID()}`,
        );
      await service.saveReview(
        evaluator,
        completeReviewInput(assignmentId, initialReview.revision, "submit"),
        "participant_ui",
      );
      await service.reopenReview(
        admin,
        {
          assignmentId,
          reason: "The reviewer needs to correct the submitted assessment.",
          confirmed: true,
        },
        "admin_ui",
      );

      await service.abstain(
        evaluator,
        {
          assignmentId,
          reason: "insufficient_expertise",
          note: "The specialist methodology falls outside my review area.",
        },
        "participant_ui",
      );

      expect(
        await testEnv.DB.prepare(
          `SELECT status, conflict_declared_at AS conflictDeclaredAt,
                  abstention_reason AS abstentionReason,
                  abstention_note AS abstentionNote,
                  abstained_at IS NOT NULL AS hasAbstainedAt
             FROM evaluator_assignments
            WHERE id = ? AND event_id = ?`,
        )
          .bind(assignmentId, evaluator.eventId)
          .first(),
      ).toEqual({
        status: "recused",
        conflictDeclaredAt: null,
        abstentionReason: "insufficient_expertise",
        abstentionNote:
          "The specialist methodology falls outside my review area.",
        hasAbstainedAt: 1,
      });
      expect(
        await testEnv.DB.prepare(
          `SELECT COUNT(*) AS count FROM evaluator_conflicts conflict
            JOIN evaluator_assignments assignment
              ON assignment.round_id = conflict.round_id
             AND assignment.evaluator_person_id = conflict.evaluator_person_id
             AND assignment.submission_id IS conflict.submission_id
             AND assignment.session_id IS conflict.session_id
           WHERE assignment.id = ? AND assignment.event_id = ?`,
        )
          .bind(assignmentId, evaluator.eventId)
          .first(),
      ).toEqual({ count: 0 });
      expect(
        await testEnv.DB.prepare(
          `SELECT action, json_extract(metadata_json, '$.reason') AS reason,
                  instr(metadata_json, ?) AS noteLeak
             FROM audit_events
            WHERE event_id = ? AND entity_id = ?
              AND action = 'review.abstained'`,
        )
          .bind(
            "The specialist methodology falls outside my review area.",
            evaluator.eventId,
            assignmentId,
          )
          .first(),
      ).toEqual({
        action: "review.abstained",
        reason: "insufficient_expertise",
        noteLeak: 0,
      });
      await expect(
        testEnv.DB.prepare(
          `SELECT status, weighted_score AS weightedScore, recommendation,
                  private_notes AS privateNotes
             FROM reviews
            WHERE assignment_id = ? AND event_id = ?`,
        )
          .bind(assignmentId, evaluator.eventId)
          .first(),
      ).resolves.toEqual({
        status: "reopened",
        weightedScore: 4,
        recommendation: "accept",
        privateNotes: "Atomic batch test.",
      });
      const adminWorkspace = await service.getAdminWorkspace(admin);
      expect(
        adminWorkspace.assignments.find(
          (assignment) => assignment.id === assignmentId,
        ),
      ).toMatchObject({
        status: "recused",
        reviewStatus: "reopened",
        scoresJson: null,
        weightedScore: null,
        recommendation: null,
        recommendationLabel: null,
        confidence: null,
        submitterFeedback: null,
        privateNotes: null,
      });
      expect(adminWorkspace.reviewCyclePreview).toMatchObject({
        unfinishedAssignmentCount: 0,
        unfinishedReviewCount: 0,
      });
      await resetEvaluationFixture();
    });

    it("records the explicit ingress origin for reviewer and manager actions", async () => {
      const { assignmentId, initialReview, service } =
        await prepareReviewerAiGenerationFixture(
          `eval-review-origin-${crypto.randomUUID()}`,
        );
      const initialOrigin = await env.DB.prepare(
        `SELECT origin FROM audit_events
          WHERE event_id = ? AND action = 'review.saved'
            AND entity_id = ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
        .bind(evaluator.eventId, initialReview.reviewId)
        .first();
      expect(initialOrigin).toEqual({ origin: "participant_ui" });

      const apiSave = await service.saveReview(
        evaluator,
        completeReviewInput(assignmentId, initialReview.revision, "save"),
        "api",
      );
      expect(
        await env.DB.prepare(
          `SELECT origin FROM audit_events
            WHERE event_id = ? AND action = 'review.saved'
              AND entity_id = ?
              AND correlation_id = (
                SELECT last_operation_id FROM reviews
                 WHERE id = ? AND event_id = ?
              )`,
        )
          .bind(
            evaluator.eventId,
            apiSave.reviewId,
            apiSave.reviewId,
            evaluator.eventId,
          )
          .first(),
      ).toEqual({ origin: "api" });

      await service.saveReview(
        evaluator,
        completeReviewInput(assignmentId, apiSave.revision, "submit"),
        "participant_ui",
      );
      const assignment = await env.DB.prepare(
        "SELECT round_id AS roundId, submission_id AS submissionId FROM evaluator_assignments WHERE id = ?",
      )
        .bind(assignmentId)
        .first<{ roundId: string; submissionId: string }>();
      await service.moderate(
        admin,
        {
          roundId: assignment!.roundId,
          submissionId: assignment!.submissionId,
          expectedModerationId: null,
          recommendation: "advance",
          moderatedScore: 4,
          notes: "The panel confirms the evidence.",
          status: "confirmed",
          confirmed: true,
        },
        "admin_ui",
      );
      await service.reopenReview(
        admin,
        {
          assignmentId,
          reason: "The reviewer must correct material evidence.",
          confirmed: true,
        },
        "admin_ui",
      );
      await service.declareConflict(
        evaluator,
        {
          assignmentId,
          reason: "A material relationship prevents impartial evaluation.",
        },
        "participant_ui",
      );

      expect(
        await env.DB.prepare(
          `SELECT action, origin FROM audit_events
            WHERE event_id = ? AND action IN (
              'review.submitted', 'review.moderation.confirmed',
              'review.reopened', 'review.conflict.declared'
            ) AND (entity_id = ? OR entity_id = ?)
            ORDER BY action`,
        )
          .bind(evaluator.eventId, apiSave.reviewId, assignmentId)
          .all(),
      ).toMatchObject({
        results: [
          { action: "review.conflict.declared", origin: "participant_ui" },
          { action: "review.reopened", origin: "admin_ui" },
          { action: "review.submitted", origin: "participant_ui" },
        ],
      });
      expect(
        await env.DB.prepare(
          `SELECT origin FROM audit_events
            WHERE event_id = ? AND action = 'review.moderation.confirmed'
            ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
          .bind(evaluator.eventId)
          .first(),
      ).toEqual({ origin: "admin_ui" });
      await resetEvaluationFixture();
    });

    it("fails before claiming work when the attempt aggregate returns no row", async () => {
      const { assignmentId, testEnv } =
        await prepareReviewerAiGenerationFixture(
          "eval-ai-missing-attempt-count-round",
        );
      let providerCalls = 0;
      const fault = withMissingFirstResult(
        testEnv,
        /SELECT COUNT\(\*\) AS count[\s\S]*substr\(operation\.idempotency_key/u,
      );

      await expect(
        new ReviewerAiSuggestionService(fault.env, {
          provider: successfulReviewerAiProvider(() => {
            providerCalls += 1;
          }),
        }).generate(evaluator, { assignmentId }),
      ).rejects.toThrow(/attempt count could not be read/i);
      expect(fault.missing()).toBe(1);
      expect(providerCalls).toBe(0);
      await resetEvaluationFixture();
    });

    it("fails explicitly when request-claim usage diagnostics return no row", async () => {
      const { assignmentId, testEnv } =
        await prepareReviewerAiGenerationFixture(
          "eval-ai-missing-usage-count-round",
        );
      let providerCalls = 0;
      const fault = withMissingFirstResult(
        testEnv,
        /SELECT\s+\(SELECT COUNT\(\*\)[\s\S]*AS assignmentCalls/u,
      );
      const racingEnv = withBatchRace(fault.env, async () => {
        await new ReviewerAiSuggestionService(testEnv).updateSetting(admin, {
          enabled: false,
          revision: 1,
        });
      });

      await expect(
        new ReviewerAiSuggestionService(racingEnv, {
          provider: successfulReviewerAiProvider(() => {
            providerCalls += 1;
          }),
        }).generate(evaluator, { assignmentId }),
      ).rejects.toThrow(/usage could not be read/i);
      expect(fault.missing()).toBe(1);
      expect(providerCalls).toBe(0);
      await resetEvaluationFixture();
    });

    it("rejects a completed provider response without model attribution", async () => {
      const { assignmentId, testEnv } =
        await prepareReviewerAiGenerationFixture(
          "eval-ai-missing-provider-model-round",
        );
      const providerResponseId = "provider-reviewer-ai-missing-model";
      const provider: AiModelProvider = {
        providerName: "Workers AI",
        model: "configured-model-must-not-be-recorded",
        async create() {
          return {
            id: providerResponseId,
            status: "completed",
            output: [],
            output_text: JSON.stringify({
              criteria: criteria.map((criterion) => ({
                criterionId: criterion.id,
                suggestedValue: "4",
                rationale: "The supplied evidence is relevant.",
                evidenceFieldIds: ["description"],
              })),
            }),
          };
        },
      };

      await expect(
        new ReviewerAiSuggestionService(testEnv, { provider }).generate(
          evaluator,
          { assignmentId },
        ),
      ).rejects.toThrow(/without model attribution/i);
      expect(
        await env.DB.prepare(
          `SELECT status,
                  json_extract(result_json, '$.providerRequestId') AS providerRequestId
             FROM operation_jobs
            WHERE event_id = ? AND type = 'ai.reviewer_suggestion.generate'
              AND json_extract(payload_json, '$.assignmentId') = ?
            ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
          .bind(evaluator.eventId, assignmentId)
          .first(),
      ).toEqual({
        status: "failed",
        providerRequestId: providerResponseId,
      });
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM reviewer_ai_suggestions
            WHERE event_id = ? AND assignment_id = ?`,
        )
          .bind(evaluator.eventId, assignmentId)
          .first(),
      ).toEqual({ count: 0 });
      await resetEvaluationFixture();
    });

    it.each([
      {
        label: "generated audit",
        pattern:
          /INSERT INTO audit_events[\s\S]*ai\.reviewer_suggestion\.generated/u,
      },
      {
        label: "operation completion",
        pattern: /UPDATE operation_jobs[\s\S]*SET status = 'completed'/u,
      },
    ])(
      "rolls back generation when $label is suppressed",
      async ({ pattern }) => {
        const { assignmentId, testEnv } =
          await prepareReviewerAiGenerationFixture(
            `eval-ai-generation-guard-${crypto.randomUUID()}`,
          );
        const fault = withSuppressedStatement(testEnv, pattern);

        await expect(
          new ReviewerAiSuggestionService(fault.env, {
            provider: successfulReviewerAiProvider(),
          }).generate(evaluator, { assignmentId }),
        ).rejects.toThrow(/complete operation evidence/i);
        expect(fault.suppressed()).toBe(1);
        expect(
          await env.DB.prepare(
            `SELECT
             (SELECT COUNT(*) FROM reviewer_ai_suggestions
               WHERE event_id = ? AND assignment_id = ?) AS suggestions,
             (SELECT COUNT(*) FROM operation_jobs
               WHERE event_id = ? AND status = 'completed'
                 AND json_extract(payload_json, '$.assignmentId') = ?) AS completed,
             (SELECT COUNT(*) FROM audit_events audit
               JOIN operation_jobs operation ON operation.id = audit.correlation_id
              WHERE audit.event_id = ?
                AND audit.action = 'ai.reviewer_suggestion.generated'
                AND json_extract(operation.payload_json, '$.assignmentId') = ?) AS generatedAudits`,
          )
            .bind(
              evaluator.eventId,
              assignmentId,
              evaluator.eventId,
              assignmentId,
              evaluator.eventId,
              assignmentId,
            )
            .first(),
        ).toEqual({ suggestions: 0, completed: 0, generatedAudits: 0 });
        await resetEvaluationFixture();
      },
    );

    it("rolls back dismissal when its audit insertion is suppressed", async () => {
      const { assignmentId, testEnv } =
        await prepareReviewerAiGenerationFixture("eval-ai-dismiss-audit-round");
      const ai = new ReviewerAiSuggestionService(testEnv, {
        provider: successfulReviewerAiProvider(),
      });
      const suggestion = await ai.generate(evaluator, { assignmentId });
      const fault = withSuppressedStatement(
        testEnv,
        /INSERT INTO audit_events[\s\S]*ai\.reviewer_suggestion\.dismissed/u,
      );

      await expect(
        new ReviewerAiSuggestionService(fault.env).dismiss(
          evaluator,
          suggestion.id,
        ),
      ).rejects.toThrow(/audit evidence/i);
      expect(fault.suppressed()).toBe(1);
      expect(
        await env.DB.prepare(
          "SELECT status, dismissed_at AS dismissedAt FROM reviewer_ai_suggestions WHERE id = ?",
        )
          .bind(suggestion.id)
          .first(),
      ).toEqual({ status: "offered", dismissedAt: null });
      await resetEvaluationFixture();
    });

    it.each(["completed", "failed"] as const)(
      "accepts an audited %s terminal operation that wins the expiry-recovery race",
      async (terminalStatus) => {
        const { assignmentId, testEnv } =
          await prepareReviewerAiGenerationFixture(
            `eval-ai-terminal-race-${terminalStatus}-round`,
          );
        const operationId = `test-ai-terminal-race-${terminalStatus}`;
        const auditId = `${operationId}-audit`;
        await env.DB.prepare(
          `INSERT INTO operation_jobs (
             id, organisation_id, event_id, requested_by_person_id, type,
             idempotency_key, correlation_id, status, payload_json,
             progress_total, progress_completed, progress_failed, attempt_count,
             cancellable, claim_token, claim_expires_at, started_at
           ) VALUES (?, ?, ?, ?, 'ai.reviewer_suggestion.generate', ?, ?,
                     'running', ?, 1, 0, 0, 1, 0, ?, unixepoch() - 1,
                     unixepoch() - 301)`,
        )
          .bind(
            operationId,
            evaluator.organisationId,
            evaluator.eventId,
            evaluator.personId,
            operationId,
            operationId,
            JSON.stringify({ assignmentId }),
            `${operationId}-claim`,
          )
          .run();
        const racingEnv = withBatchRace(testEnv, async () => {
          if (terminalStatus === "completed") {
            await env.DB.batch([
              env.DB.prepare(
                `INSERT INTO audit_events (
                   id, actor_kind, origin, metadata_version, organisation_id,
                   event_id, actor_person_id, actor_id, action, entity_type,
                   entity_id, correlation_id, metadata_json, created_at
                 ) VALUES (?, 'agent', 'participant_ui', 1, ?, ?, ?,
                           'program_cue_reviewer_ai',
                           'ai.reviewer_suggestion.generated',
                           'reviewer_ai_suggestion', ?, ?, ?, unixepoch())`,
              ).bind(
                auditId,
                evaluator.organisationId,
                evaluator.eventId,
                evaluator.personId,
                `${operationId}-suggestion`,
                operationId,
                JSON.stringify({
                  assignmentId,
                  provider: "workers_ai",
                  model: "test-reviewer-ai-model",
                  providerResponseId: `${operationId}-response`,
                  evidenceFieldIds: [],
                }),
              ),
              env.DB.prepare(
                `UPDATE operation_jobs
                    SET status = 'completed', progress_completed = 1,
                        result_json = ?, claim_token = NULL,
                        claim_expires_at = NULL, completed_at = unixepoch(),
                        updated_at = unixepoch()
                  WHERE id = ?`,
              ).bind(
                JSON.stringify({
                  suggestionId: `${operationId}-suggestion`,
                  providerResponseId: `${operationId}-response`,
                }),
                operationId,
              ),
            ]);
            return;
          }
          const message = "Another recovery actor recorded the interruption.";
          const recoveryId = `${operationId}-recovery`;
          await env.DB.batch([
            env.DB.prepare(
              `INSERT INTO audit_events (
                 id, actor_kind, origin, metadata_version, organisation_id,
                 event_id, actor_person_id, actor_id, action, entity_type,
                 entity_id, correlation_id, metadata_json, created_at
               ) VALUES (?, 'agent', 'participant_ui', 1, ?, ?, ?,
                         'program_cue_reviewer_ai',
                         'ai.reviewer_suggestion.interrupted', 'operation',
                         ?, ?, ?, unixepoch())`,
            ).bind(
              auditId,
              evaluator.organisationId,
              evaluator.eventId,
              evaluator.personId,
              operationId,
              operationId,
              JSON.stringify({ message, retrySafe: false, recoveryId }),
            ),
            env.DB.prepare(
              `UPDATE operation_jobs
                  SET status = 'failed', progress_failed = 1, last_error = ?,
                      result_json = ?, claim_token = NULL,
                      claim_expires_at = NULL, completed_at = unixepoch(),
                      updated_at = unixepoch()
                WHERE id = ?`,
            ).bind(
              message,
              JSON.stringify({
                errorType: "InterruptedAiRequest",
                providerRequestId: null,
                retrySafe: false,
                recoveryId,
              }),
              operationId,
            ),
          ]);
        });

        const retry = await new ReviewerAiSuggestionService(
          racingEnv,
        ).getRetryForAssignment(evaluator, assignmentId);
        if (terminalStatus === "completed") {
          expect(retry).toBeNull();
        } else {
          expect(retry).toMatchObject({ operationId });
        }
        await resetEvaluationFixture();
      },
    );

    it("enforces a rolling transactional per-assignment reviewer AI request limit", async () => {
      const { assignmentId, testEnv } =
        await prepareReviewerAiGenerationFixture(
          "eval-ai-assignment-limit-round",
        );
      let providerCalls = 0;
      try {
        for (let index = 1; index <= 3; index += 1) {
          await env.DB.prepare(
            `INSERT INTO operation_jobs (
               id, organisation_id, event_id, requested_by_person_id, type,
               idempotency_key, correlation_id, status, payload_json,
               progress_total, progress_failed, attempt_count, cancellable,
               completed_at
             ) VALUES (?, ?, ?, ?, 'ai.reviewer_suggestion.generate', ?, ?,
                       'failed', ?, 1, 1, 1, 0, unixepoch())`,
          )
            .bind(
              `test-ai-assignment-limit-${index}`,
              evaluator.organisationId,
              evaluator.eventId,
              evaluator.personId,
              `test-ai-assignment-limit-${index}`,
              `test-ai-assignment-limit-${index}`,
              JSON.stringify({ assignmentId }),
            )
            .run();
        }

        await expect(
          new ReviewerAiSuggestionService(testEnv, {
            provider: successfulReviewerAiProvider(() => {
              providerCalls += 1;
            }),
          }).generate(evaluator, { assignmentId }),
        ).rejects.toThrow(/3-request reviewer AI limit/i);
        expect(providerCalls).toBe(0);

        await env.DB.prepare(
          `UPDATE operation_jobs
              SET created_at = unixepoch() - 86401
            WHERE id LIKE 'test-ai-assignment-limit-%'`,
        ).run();
        await new ReviewerAiSuggestionService(testEnv, {
          provider: successfulReviewerAiProvider(() => {
            providerCalls += 1;
          }),
        }).generate(evaluator, { assignmentId });
        expect(providerCalls).toBe(1);
      } finally {
        await env.DB.prepare(
          "DELETE FROM operation_jobs WHERE id LIKE 'test-ai-assignment-limit-%'",
        ).run();
        await resetEvaluationFixture();
      }
    });

    it("enforces the transactional organisation reviewer AI daily limit", async () => {
      const { assignmentId, testEnv } =
        await prepareReviewerAiGenerationFixture(
          "eval-ai-organisation-limit-round",
        );
      let providerCalls = 0;
      try {
        await env.DB.prepare(
          `WITH RECURSIVE numbers(value) AS (
             SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 100
           )
           INSERT INTO operation_jobs (
             id, organisation_id, event_id, requested_by_person_id, type,
             idempotency_key, correlation_id, status, payload_json,
             progress_total, progress_failed, attempt_count, cancellable,
             completed_at
           )
           SELECT 'test-ai-org-limit-' || value, ?, ?, ?,
                  'ai.reviewer_suggestion.generate',
                  'test-ai-org-limit-' || value,
                  'test-ai-org-limit-' || value,
                  'failed', json_object('assignmentId', 'other-' || value),
                  1, 1, 1, 0, unixepoch()
             FROM numbers`,
        )
          .bind(evaluator.organisationId, evaluator.eventId, evaluator.personId)
          .run();

        await expect(
          new ReviewerAiSuggestionService(testEnv, {
            provider: successfulReviewerAiProvider(() => {
              providerCalls += 1;
            }),
          }).generate(evaluator, { assignmentId }),
        ).rejects.toThrow(/organisation.*last 24 hours/i);
        expect(providerCalls).toBe(0);
      } finally {
        await env.DB.prepare(
          "DELETE FROM operation_jobs WHERE id LIKE 'test-ai-org-limit-%'",
        ).run();
        await resetEvaluationFixture();
      }
    });

    it("blocks a different-revision request while provider work is live and preserves failed-call acknowledgement", async () => {
      const { assignmentId, initialReview, service, testEnv } =
        await prepareReviewerAiGenerationFixture(
          "eval-ai-different-revision-round",
        );
      let releaseProvider!: () => void;
      let providerStarted!: () => void;
      const providerRelease = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const providerStart = new Promise<void>((resolve) => {
        providerStarted = resolve;
      });
      let providerCalls = 0;
      const provider: AiModelProvider = {
        providerName: "Workers AI",
        model: "test-reviewer-boundary-model",
        async create() {
          providerCalls += 1;
          providerStarted();
          await providerRelease;
          return {
            id: "provider-reviewer-boundary-1",
            model: "test-reviewer-boundary-model",
            status: "completed",
            output: [],
            output_text: JSON.stringify({
              criteria: criteria.map((criterion) => ({
                criterionId: criterion.id,
                suggestedValue: "4",
                rationale:
                  "The submitted description contains concrete evidence relevant to this criterion.",
                evidenceFieldIds: ["description"],
              })),
            }),
          };
        },
      };
      const ai = new ReviewerAiSuggestionService(testEnv, { provider });
      let released = false;

      try {
        const firstGeneration = ai.generate(evaluator, { assignmentId });
        await providerStart;
        await service.saveReview(
          evaluator,
          {
            assignmentId,
            revision: initialReview.revision,
            scores: { "eval-test-relevance": 4 },
            recommendation: null,
            confidence: null,
            submitterFeedback: "",
            privateNotes: "",
            conflictAffirmed: false,
            intent: "save",
          },
          "participant_ui",
        );

        await expect(ai.generate(evaluator, { assignmentId })).rejects.toThrow(
          /another request is already being generated/i,
        );
        expect(providerCalls).toBe(1);

        released = true;
        releaseProvider();
        await expect(firstGeneration).rejects.toThrow(/assignment changed/i);

        const retry = await ai.getRetryForAssignment(evaluator, assignmentId);
        expect(retry).toMatchObject({
          providerRequestId: "provider-reviewer-boundary-1",
        });
        await expect(ai.generate(evaluator, { assignmentId })).rejects.toThrow(
          /possible duplicate request or charge/i,
        );
        expect(providerCalls).toBe(1);
      } finally {
        if (!released) releaseProvider();
        await resetEvaluationFixture();
      }
    });

    it("generates assignment-specific suggestions and requires confirmation for unchanged imports", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      const service = new EvaluationService(testEnv);
      const suggestionCriteria = [
        ...criteria,
        {
          id: "eval-test-evidence-present",
          name: "Evidence present",
          description: "Whether the proposal supplies concrete evidence.",
          inputType: "yes_no" as const,
          weightPercent: 0,
          required: true,
          position: criteria.length,
        },
        {
          id: "eval-test-reviewer-observation",
          name: "Reviewer observation",
          description: "A reviewer-authored observation.",
          inputType: "free_text" as const,
          weightPercent: 0,
          required: false,
          position: criteria.length + 1,
        },
      ];
      await service.savePlan(admin, {
        revision: 0,
        name: "AI reviewer suggestion plan",
        status: "active",
        rounds: [
          {
            id: "eval-ai-suggestion-round",
            name: "Initial review",
            anonymous: true,
            recommendationChoices: defaultRecommendationChoices(),
            criteria: suggestionCriteria,
          },
        ],
      });
      await addRoundReviewer("eval-ai-suggestion-round");
      await service.assign(admin, {
        roundId: "eval-ai-suggestion-round",
        targetType: "submission",
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
      });
      let workspace = await service.getReviewerWorkspace(evaluator);
      const assignmentId = workspace.selected!.id;
      const initial = await service.saveReview(
        evaluator,
        {
          assignmentId,
          revision: 0,
          scores: {
            "eval-test-relevance": 3,
            "eval-test-reviewer-observation":
              "My independent first impression.",
          },
          recommendation: null,
          confidence: null,
          submitterFeedback: "",
          privateNotes: "",
          conflictAffirmed: false,
          intent: "save",
        },
        "participant_ui",
      );
      let releaseProvider!: () => void;
      let providerStarted!: () => void;
      const providerRelease = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const providerStart = new Promise<void>((resolve) => {
        providerStarted = resolve;
      });
      let providerCalls = 0;
      const provider: AiModelProvider = {
        providerName: "Workers AI",
        model: "test-reviewer-suggestion-model",
        async create(request) {
          providerCalls += 1;
          providerStarted();
          await providerRelease;
          expect(String(request.input)).toContain("eval-test-relevance");
          expect(String(request.input)).not.toContain("privateNotes");
          return {
            id: "provider-reviewer-suggestion-1",
            model: "test-reviewer-suggestion-model",
            status: "completed",
            output: [],
            output_text: JSON.stringify({
              criteria: suggestionCriteria.map((criterion) => ({
                criterionId: criterion.id,
                suggestedValue:
                  criterion.inputType === "free_text"
                    ? null
                    : criterion.inputType === "yes_no"
                      ? "yes"
                      : "4",
                rationale:
                  "The proposal description supplies relevant, concrete evidence for this criterion.",
                evidenceFieldIds: ["description"],
              })),
            }),
          };
        },
      };
      const ai = new ReviewerAiSuggestionService(testEnv, { provider });
      await ai.updateSetting(admin, { enabled: true, revision: 0 });

      workspace = await service.getReviewerWorkspace(evaluator, assignmentId);
      const interruptedOperationId = "test-interrupted-reviewer-ai";
      await env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           progress_total, progress_completed, progress_failed, attempt_count,
           cancellable, claim_token, claim_expires_at, started_at
         ) VALUES (?, ?, ?, ?, 'ai.reviewer_suggestion.generate', ?, ?,
                   'running', ?, 1, 0, 0, 1, 0, ?, unixepoch() - 1,
                   unixepoch() - 301)`,
      )
        .bind(
          interruptedOperationId,
          evaluator.organisationId,
          evaluator.eventId,
          evaluator.personId,
          interruptedOperationId,
          interruptedOperationId,
          JSON.stringify({
            assignmentId,
            assignmentRevision: workspace.selected!.revision,
            roundId: workspace.selected!.roundId,
            scorecardId: workspace.selected!.scorecardId,
            scorecardVersion: workspace.selected!.scorecardVersion,
          }),
          "expired-reviewer-ai-claim",
        )
        .run();
      const interruptedRetry = await ai.getRetryForAssignment(
        evaluator,
        assignmentId,
      );
      expect(interruptedRetry).toMatchObject({
        operationId: interruptedOperationId,
        providerRequestId: null,
      });
      await expect(ai.generate(evaluator, { assignmentId })).rejects.toThrow(
        /possible duplicate request or charge/i,
      );
      expect(providerCalls).toBe(0);

      const generation = ai.generate(evaluator, {
        assignmentId,
        retryFailedOperationId: interruptedOperationId,
        duplicateRiskAcknowledged: true,
      });
      await providerStart;
      await expect(ai.generate(evaluator, { assignmentId })).rejects.toThrow(
        /already being generated/i,
      );
      await env.DB.prepare(
        `UPDATE evaluation_rounds SET closes_at = unixepoch() - 1
          WHERE id = ? AND event_id = ?`,
      )
        .bind("eval-ai-suggestion-round", evaluator.eventId)
        .run();
      releaseProvider();
      await expect(generation).rejects.toThrow(/assignment changed/i);
      expect(await ai.getForAssignment(evaluator, assignmentId)).toBeNull();
      expect(
        await env.DB.prepare(
          `SELECT status,
                  json_extract(result_json, '$.providerRequestId') AS providerRequestId
             FROM operation_jobs
            WHERE event_id = ? AND type = 'ai.reviewer_suggestion.generate'
              AND id <> ?
              AND json_extract(payload_json, '$.assignmentId') = ?
            ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
          .bind(evaluator.eventId, interruptedOperationId, assignmentId)
          .first(),
      ).toEqual({
        status: "failed",
        providerRequestId: "provider-reviewer-suggestion-1",
      });
      await env.DB.prepare(
        `UPDATE evaluation_rounds SET closes_at = NULL
          WHERE id = ? AND event_id = ?`,
      )
        .bind("eval-ai-suggestion-round", evaluator.eventId)
        .run();
      const retry = await ai.getRetryForAssignment(evaluator, assignmentId);
      expect(retry).toMatchObject({
        providerRequestId: "provider-reviewer-suggestion-1",
      });
      await expect(ai.generate(evaluator, { assignmentId })).rejects.toThrow(
        /possible duplicate request or charge/i,
      );
      expect(providerCalls).toBe(1);
      const suggestion = await ai.generate(evaluator, {
        assignmentId,
        retryFailedOperationId: retry!.operationId,
        duplicateRiskAcknowledged: true,
      });

      expect(suggestion).toMatchObject({
        assignmentId,
        status: "offered",
        providerResponseId: "provider-reviewer-suggestion-1",
      });
      expect(providerCalls).toBe(2);
      expect(suggestion.suggestions).toHaveLength(suggestionCriteria.length);
      expect(
        await ai.getForAssignment(
          { ...evaluator, personId: admin.personId },
          assignmentId,
        ),
      ).toBeNull();

      const suggestedScores = Object.fromEntries(
        suggestionCriteria.map((criterion) => [
          criterion.id,
          criterion.inputType === "free_text"
            ? "My independent first impression."
            : criterion.inputType === "yes_no"
              ? true
              : 4,
        ]),
      );
      const reviewScores = {
        ...suggestedScores,
        "eval-test-relevance": 3,
      };
      const allSuggestedClosedIds = suggestionCriteria
        .filter((criterion) => criterion.inputType !== "free_text")
        .map((criterion) => criterion.id);
      const importedIds = suggestionCriteria
        .filter(
          (criterion) =>
            criterion.inputType !== "free_text" &&
            criterion.id !== "eval-test-relevance",
        )
        .map((criterion) => criterion.id);
      await ai.updateSetting(admin, { enabled: false, revision: 1 });
      await expect(
        service.saveReview(
          evaluator,
          {
            assignmentId,
            revision: initial.revision,
            scores: suggestedScores,
            recommendation: "accept",
            confidence: 4,
            submitterFeedback: "",
            privateNotes: "",
            conflictAffirmed: true,
            suggestionId: suggestion.id,
            importedCriterionIds: importedIds,
            intent: "save",
          },
          "participant_ui",
        ),
      ).rejects.toThrow(/suggestion changed/i);
      expect((await ai.getForAssignment(evaluator, assignmentId))?.status).toBe(
        "offered",
      );
      await ai.updateSetting(admin, { enabled: true, revision: 2 });
      await expect(
        service.saveReview(
          evaluator,
          {
            assignmentId,
            revision: initial.revision,
            scores: suggestedScores,
            recommendation: "accept",
            confidence: 4,
            submitterFeedback: "",
            privateNotes: "",
            conflictAffirmed: true,
            suggestionId: suggestion.id,
            importedCriterionIds: allSuggestedClosedIds,
            intent: "save",
          },
          "participant_ui",
        ),
      ).rejects.toThrow(/only fill criteria that were unanswered/i);
      const imported = await service.saveReview(
        evaluator,
        {
          assignmentId,
          revision: initial.revision,
          scores: reviewScores,
          recommendation: "accept",
          confidence: 4,
          submitterFeedback: "",
          privateNotes: "",
          conflictAffirmed: true,
          suggestionId: suggestion.id,
          importedCriterionIds: importedIds,
          intent: "save",
        },
        "participant_ui",
      );
      expect((await ai.getForAssignment(evaluator, assignmentId))?.status).toBe(
        "imported",
      );

      await expect(
        service.saveReview(
          evaluator,
          {
            assignmentId,
            revision: imported.revision,
            scores: reviewScores,
            recommendation: "accept",
            confidence: 4,
            submitterFeedback: "",
            privateNotes: "",
            conflictAffirmed: true,
            suggestionId: suggestion.id,
            importedCriterionIds: importedIds,
            confirmedAiCriterionIds: [],
            intent: "submit",
          },
          "participant_ui",
        ),
      ).rejects.toThrow(/confirm every unchanged AI-derived criterion/i);

      await service.saveReview(
        evaluator,
        {
          assignmentId,
          revision: imported.revision,
          scores: reviewScores,
          recommendation: "accept",
          confidence: 4,
          submitterFeedback: "",
          privateNotes: "",
          conflictAffirmed: true,
          suggestionId: suggestion.id,
          importedCriterionIds: importedIds,
          confirmedAiCriterionIds: importedIds,
          intent: "submit",
        },
        "participant_ui",
      );
      const revision = await env.DB.prepare(
        `SELECT ai_suggestion_id AS suggestionId,
                imported_criterion_ids_json AS importedIdsJson,
                confirmed_ai_criterion_ids_json AS confirmedIdsJson
           FROM review_revisions
          WHERE event_id = ? AND review_id = ?
          ORDER BY revision_number DESC LIMIT 1`,
      )
        .bind(evaluator.eventId, imported.reviewId)
        .first<{
          suggestionId: string;
          importedIdsJson: string;
          confirmedIdsJson: string;
        }>();
      expect(revision?.suggestionId).toBe(suggestion.id);
      expect(JSON.parse(revision!.importedIdsJson)).toEqual(importedIds);
      expect(JSON.parse(revision!.confirmedIdsJson)).toEqual(importedIds);
      expect(
        await env.DB.prepare(
          `SELECT json_extract(scores_json, '$.eval-test-relevance') AS relevance
             FROM reviews WHERE id = ? AND event_id = ?`,
        )
          .bind(imported.reviewId, evaluator.eventId)
          .first(),
      ).toEqual({ relevance: 3 });
      expect(
        await env.DB.prepare(
          `SELECT lifecycle_operation_id IS NOT NULL AS hasLifecycleOperation
             FROM reviewer_ai_suggestions WHERE id = ?`,
        )
          .bind(suggestion.id)
          .first(),
      ).toEqual({ hasLifecycleOperation: 1 });
      await service.reopenReview(
        admin,
        {
          assignmentId,
          reason: "Recheck the AI-assisted scoring provenance.",
          confirmed: true,
        },
        "admin_ui",
      );
      const reopenedRevision = await env.DB.prepare(
        `SELECT ai_suggestion_id AS suggestionId,
                imported_criterion_ids_json AS importedIdsJson,
                confirmed_ai_criterion_ids_json AS confirmedIdsJson
           FROM review_revisions
          WHERE event_id = ? AND review_id = ? AND save_kind = 'reopened'
          ORDER BY revision_number DESC LIMIT 1`,
      )
        .bind(evaluator.eventId, imported.reviewId)
        .first<{
          suggestionId: string;
          importedIdsJson: string;
          confirmedIdsJson: string;
        }>();
      expect(reopenedRevision?.suggestionId).toBe(suggestion.id);
      expect(JSON.parse(reopenedRevision!.importedIdsJson)).toEqual(
        importedIds,
      );
      expect(JSON.parse(reopenedRevision!.confirmedIdsJson)).toEqual(
        importedIds,
      );
      await resetEvaluationFixture();
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
            recommendationChoices: [
              { id: "strong_accept", label: "Strong accept" },
              { id: "discuss", label: "Discuss" },
              { id: "decline", label: "Decline" },
            ],
            criteria,
          },
        ],
      });
      await addRoundReviewer("eval-test-round");
      await service.assign(admin, {
        roundId: "eval-test-round",
        targetType: "submission",
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
      });

      const workspace = await service.getReviewerWorkspace(evaluator);
      expect(workspace.selected?.submissionId).toBe("eval-test-submission");
      expect(workspace.selected?.blindedReviewing).toBe(true);
      expect(workspace.recommendationChoices).toEqual([
        { id: "strong_accept", label: "Strong accept" },
        { id: "discuss", label: "Discuss" },
        { id: "decline", label: "Decline" },
      ]);
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
      const draft = await service.saveReview(
        evaluator,
        {
          assignmentId: workspace.selected!.id,
          revision: 0,
          scores,
          recommendation: null,
          confidence: null,
          submitterFeedback: "Useful proposal.",
          privateNotes: "",
          intent: "save",
        },
        "participant_ui",
      );
      expect(draft.revision).toBe(1);

      await expect(
        service.saveReview(
          evaluator,
          {
            assignmentId: workspace.selected!.id,
            revision: 1,
            scores: { [criteria[0]!.id]: 4 },
            recommendation: "strong_accept",
            confidence: 4,
            submitterFeedback: "Useful proposal.",
            privateNotes: "Recommend acceptance.",
            conflictAffirmed: true,
            intent: "submit",
          },
          "participant_ui",
        ),
      ).rejects.toBeInstanceOf(EvaluationValidationError);

      await expect(
        service.saveReview(
          evaluator,
          {
            assignmentId: workspace.selected!.id,
            revision: 1,
            scores,
            recommendation: "accept",
            confidence: 4,
            submitterFeedback: "Useful proposal.",
            privateNotes: "Recommend acceptance.",
            conflictAffirmed: true,
            intent: "submit",
          },
          "participant_ui",
        ),
      ).rejects.toThrow(/available for this evaluation round/i);

      const submitted = await service.saveReview(
        evaluator,
        {
          assignmentId: workspace.selected!.id,
          revision: 1,
          scores,
          recommendation: "strong_accept",
          confidence: 4,
          submitterFeedback: "Useful proposal.",
          privateNotes: "Recommend acceptance.",
          conflictAffirmed: true,
          intent: "submit",
        },
        "participant_ui",
      );
      expect(submitted.weightedScore).toBe(4.25);
      const stored = await env.DB.prepare(
        `SELECT status, revision, recommendation,
                recommendation_choices_snapshot_json AS recommendationChoicesSnapshotJson,
                conflict_affirmed_at AS conflictAffirmedAt
           FROM reviews WHERE id = ?`,
      )
        .bind(submitted.reviewId)
        .first<{
          status: string;
          revision: number;
          recommendation: string;
          recommendationChoicesSnapshotJson: string;
          conflictAffirmedAt: number | null;
        }>();
      expect(stored).toMatchObject({
        status: "submitted",
        revision: 2,
        recommendation: "strong_accept",
        conflictAffirmedAt: expect.any(Number),
      });
      expect(JSON.parse(stored!.recommendationChoicesSnapshotJson)).toEqual(
        workspace.recommendationChoices,
      );
      const revisionEvidence = await env.DB.prepare(
        `SELECT scorecard_id AS scorecardId,
                scorecard_version AS scorecardVersion,
                criteria_snapshot_json AS criteriaSnapshotJson
           FROM review_revisions
          WHERE review_id = ? AND revision_number = 2`,
      )
        .bind(submitted.reviewId)
        .first<{
          scorecardId: string;
          scorecardVersion: number;
          criteriaSnapshotJson: string;
        }>();
      expect(revisionEvidence).toMatchObject({
        scorecardId: "eval-test-round",
        scorecardVersion: 1,
      });
      expect(JSON.parse(revisionEvidence!.criteriaSnapshotJson)).toEqual(
        criteria.map((criterion, position) =>
          expect.objectContaining({
            id: criterion.id,
            name: criterion.name,
            position,
          }),
        ),
      );
      const submittedWorkspace = await service.getReviewerWorkspace(evaluator);
      expect(submittedWorkspace.selected?.status).toBe("submitted");
      expect(submittedWorkspace.review?.status).toBe("submitted");
      await env.DB.prepare(
        `UPDATE submissions SET status = 'waitlisted' WHERE id = ? AND event_id = ?`,
      )
        .bind("eval-test-submission", evaluator.eventId)
        .run();
      try {
        const waitlistedWorkspace = await service.getReviewerWorkspace(
          evaluator,
          submittedWorkspace.selected!.id,
        );
        expect(waitlistedWorkspace.selected?.id).toBe(
          submittedWorkspace.selected!.id,
        );
        expect(waitlistedWorkspace.review?.status).toBe("submitted");
        await env.DB.prepare(
          `UPDATE evaluation_rounds SET status = 'closed'
            WHERE id = 'eval-test-round' AND event_id = ?`,
        )
          .bind(evaluator.eventId)
          .run();
        await env.DB.prepare(
          `UPDATE evaluation_plans SET status = 'closed'
            WHERE event_id = ? AND status = 'active'`,
        )
          .bind(evaluator.eventId)
          .run();
        const closedRoundWorkspace = await service.getReviewerWorkspace(
          evaluator,
          submittedWorkspace.selected!.id,
        );
        expect(closedRoundWorkspace.selected?.id).toBe(
          submittedWorkspace.selected!.id,
        );
        expect(closedRoundWorkspace.review).toMatchObject({
          status: "submitted",
          weightedScore: 4.25,
          recommendation: "strong_accept",
          privateNotes: "Recommend acceptance.",
          submitterFeedback: "Useful proposal.",
          revision: 2,
        });
      } finally {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE evaluation_rounds SET status = 'active'
              WHERE id = 'eval-test-round' AND event_id = ?`,
          ).bind(evaluator.eventId),
          env.DB.prepare(
            `UPDATE evaluation_plans SET status = 'active'
              WHERE event_id = ? AND status = 'closed'`,
          ).bind(evaluator.eventId),
          env.DB.prepare(
            `UPDATE submissions SET status = 'submitted'
              WHERE id = ? AND event_id = ?`,
          ).bind("eval-test-submission", evaluator.eventId),
        ]);
      }
      await expect(
        service.saveReview(
          evaluator,
          {
            assignmentId: workspace.selected!.id,
            revision: 2,
            scores,
            recommendation: "reject",
            confidence: 5,
            submitterFeedback: "",
            privateNotes: "",
            conflictAffirmed: true,
            intent: "submit",
          },
          "participant_ui",
        ),
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
              recommendationChoices: defaultRecommendationChoices(),
              criteria,
            },
          ],
        });
        adminWorkspace = await service.getAdminWorkspace(admin);
      }
      const roundId =
        adminWorkspace.plan!.rounds.find((round) => round.status === "active")
          ?.id ?? adminWorkspace.plan!.rounds[0]!.id;
      await addRoundReviewer(roundId);
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
              recommendationChoices: defaultRecommendationChoices(),
              criteria,
            },
          ],
        });
        adminWorkspace = await service.getAdminWorkspace(admin);
      }
      await addRoundReviewer(adminWorkspace.plan!.rounds[0]!.id);
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
        service.saveReview(
          evaluator,
          {
            assignmentId: workspace.selected!.id,
            revision: 0,
            scores,
            recommendation: "accept",
            confidence: 4,
            submitterFeedback: "A useful proposal.",
            privateNotes: "",
            conflictAffirmed: true,
            intent: "submit",
          },
          "participant_ui",
        ),
        service.declareConflict(
          evaluator,
          {
            assignmentId: workspace.selected!.id,
            reason:
              "A close working relationship prevents an impartial review.",
          },
          "participant_ui",
        ),
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
