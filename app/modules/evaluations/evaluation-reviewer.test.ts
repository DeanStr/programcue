import { env } from "cloudflare:test";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { formSchemaSchema } from "~/modules/submissions/submission-schema";
import { ReviewerAiSuggestionService } from "~/modules/ai/reviewer-ai-suggestion.server";
import type { AiModelProvider } from "~/modules/ai/openai-responses-provider.server";
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

async function resetEvaluationFixture() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM event_ai_review_settings WHERE event_id = ?").bind(
      admin.eventId,
    ),
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
      const initial = await service.saveReview(evaluator, {
        assignmentId,
        revision: 0,
        scores: {
          "eval-test-relevance": 3,
          "eval-test-reviewer-observation": "My independent first impression.",
        },
        recommendation: null,
        confidence: null,
        submitterFeedback: "",
        privateNotes: "",
        conflictAffirmed: false,
        intent: "save",
      });
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
            ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
          .bind(evaluator.eventId, interruptedOperationId)
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
      const importedIds = suggestionCriteria
        .filter((criterion) => criterion.inputType !== "free_text")
        .map((criterion) => criterion.id);
      await ai.updateSetting(admin, { enabled: false, revision: 1 });
      await expect(
        service.saveReview(evaluator, {
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
        }),
      ).rejects.toThrow(/suggestion changed/i);
      expect((await ai.getForAssignment(evaluator, assignmentId))?.status).toBe(
        "offered",
      );
      await ai.updateSetting(admin, { enabled: true, revision: 2 });
      const imported = await service.saveReview(evaluator, {
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
      });
      expect((await ai.getForAssignment(evaluator, assignmentId))?.status).toBe(
        "imported",
      );

      await expect(
        service.saveReview(evaluator, {
          assignmentId,
          revision: imported.revision,
          scores: suggestedScores,
          recommendation: "accept",
          confidence: 4,
          submitterFeedback: "",
          privateNotes: "",
          conflictAffirmed: true,
          suggestionId: suggestion.id,
          importedCriterionIds: importedIds,
          confirmedAiCriterionIds: [],
          intent: "submit",
        }),
      ).rejects.toThrow(/confirm every unchanged AI-derived criterion/i);

      await service.saveReview(evaluator, {
        assignmentId,
        revision: imported.revision,
        scores: suggestedScores,
        recommendation: "accept",
        confidence: 4,
        submitterFeedback: "",
        privateNotes: "",
        conflictAffirmed: true,
        suggestionId: suggestion.id,
        importedCriterionIds: importedIds,
        confirmedAiCriterionIds: importedIds,
        intent: "submit",
      });
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
          `SELECT lifecycle_operation_id IS NOT NULL AS hasLifecycleOperation,
                  imported_review_id AS importedReviewId
             FROM reviewer_ai_suggestions WHERE id = ?`,
        )
          .bind(suggestion.id)
          .first(),
      ).toEqual({ hasLifecycleOperation: 1, importedReviewId: imported.reviewId });
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
          conflictAffirmed: true,
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
        conflictAffirmed: true,
        intent: "submit",
      });
      expect(submitted.weightedScore).toBe(4.25);
      const stored = await env.DB.prepare(
        `SELECT status, revision,
                conflict_affirmed_at AS conflictAffirmedAt
           FROM reviews WHERE id = ?`,
      )
        .bind(submitted.reviewId)
        .first<{
          status: string;
          revision: number;
          conflictAffirmedAt: number | null;
        }>();
      expect(stored).toEqual({
        status: "submitted",
        revision: 2,
        conflictAffirmedAt: expect.any(Number),
      });
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
      await expect(
        service.saveReview(evaluator, {
          assignmentId: workspace.selected!.id,
          revision: 2,
          scores,
          recommendation: "reject",
          confidence: 5,
          submitterFeedback: "",
          privateNotes: "",
          conflictAffirmed: true,
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
        service.saveReview(evaluator, {
          assignmentId: workspace.selected!.id,
          revision: 0,
          scores,
          recommendation: "accept",
          confidence: 4,
          submitterFeedback: "A useful proposal.",
          privateNotes: "",
          conflictAffirmed: true,
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
