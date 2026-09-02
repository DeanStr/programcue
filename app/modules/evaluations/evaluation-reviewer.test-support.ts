import { env } from "cloudflare:test";
import { requireValue } from "~/lib/required-value";
import type { AiModelProvider } from "~/modules/ai/openai-responses-provider.server";

import { ReviewerAiSuggestionService } from "~/modules/ai/reviewer-ai-suggestion.server";

import type { Viewer } from "~/platform/auth/authorize.server";

import { defaultRecommendationChoices } from "./evaluation-recommendation-choices";

import { EvaluationService } from "./evaluation-service.server";

export const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

export const evaluator: Viewer = {
  personId: "person-demo-evaluator",
  name: "Jordan Lee",
  email: "jordan.evaluator@example.com",
  role: "evaluator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

export function evaluationEnvironment(
  base = env as unknown as CloudflareEnvironment,
) {
  return {
    ...base,
    OPERATIONS_QUEUE: { send: async () => undefined },
  } as unknown as CloudflareEnvironment;
}

export const criteria = [
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

export function submittedSnapshot(
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

export function withBatchRace(
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

export function withSuppressedStatement(
  testEnv: CloudflareEnvironment,
  pattern: RegExp,
) {
  let suppressed = 0;
  const faultingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (suppressed > 0 || !pattern.test(query)) return statement;
          suppressed += 1;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "bind") {
                return () =>
                  target.prepare(
                    "UPDATE people SET display_name = display_name WHERE 0",
                  );
              }
              const value = Reflect.get(statementTarget, statementProperty);
              return typeof value === "function"
                ? value.bind(statementTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    env: new Proxy(testEnv, {
      get(target, property) {
        return property === "DB" ? faultingDb : Reflect.get(target, property);
      },
    }),
    suppressed: () => suppressed,
  };
}

export function withMissingFirstResult(
  testEnv: CloudflareEnvironment,
  pattern: RegExp,
) {
  let missing = 0;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        if (property === "first") {
          return async () => {
            missing += 1;
            return null;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const faultingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return pattern.test(query) ? wrap(statement) : statement;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    env: new Proxy(testEnv, {
      get(target, property) {
        return property === "DB" ? faultingDb : Reflect.get(target, property);
      },
    }),
    missing: () => missing,
  };
}

export function successfulReviewerAiProvider(
  onCall?: () => void,
): AiModelProvider {
  return {
    providerName: "Workers AI",
    model: "test-reviewer-ai-model",
    async create() {
      onCall?.();
      return {
        id: crypto.randomUUID(),
        model: "test-reviewer-ai-model",
        status: "completed",
        output: [],
        output_text: JSON.stringify({
          criteria: criteria.map((criterion) => ({
            criterionId: criterion.id,
            suggestedValue: "4",
            rationale:
              "The proposal description supplies relevant concrete evidence for this criterion.",
            evidenceFieldIds: ["description"],
          })),
        }),
      };
    },
  };
}

export async function resetEvaluationFixture() {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM event_ai_review_settings WHERE event_id = ?",
    ).bind(admin.eventId),
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

export async function addRoundReviewer(
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

export async function prepareReviewerAiGenerationFixture(roundId: string) {
  await resetEvaluationFixture();
  const testEnv = env as unknown as CloudflareEnvironment;
  const service = new EvaluationService(testEnv);
  await service.savePlan(admin, {
    revision: 0,
    name: "Reviewer AI provider-boundary plan",
    status: "active",
    rounds: [
      {
        id: roundId,
        name: "Initial review",
        anonymous: true,
        recommendationChoices: defaultRecommendationChoices(),
        criteria,
      },
    ],
  });
  await addRoundReviewer(roundId);
  await service.assign(admin, {
    roundId,
    targetType: "submission",
    targetIds: ["eval-test-submission"],
    evaluatorPersonIds: [evaluator.personId],
  });
  const workspace = await service.getReviewerWorkspace(evaluator);
  const assignmentId = requireValue(
    workspace.selected?.id,
    "Expected the reviewer fixture to create an assignment.",
  );
  const initialReview = await service.saveReview(
    evaluator,
    {
      assignmentId,
      revision: 0,
      scores: { "eval-test-relevance": 3 },
      recommendation: null,
      confidence: null,
      submitterFeedback: "",
      privateNotes: "",
      conflictAffirmed: false,
      intent: "save",
    },
    "participant_ui",
  );
  await new ReviewerAiSuggestionService(testEnv).updateSetting(admin, {
    enabled: true,
    revision: 0,
  });
  return { assignmentId, initialReview, service, testEnv };
}

export function completeReviewInput(
  assignmentId: string,
  revision: number,
  intent: "save" | "submit",
) {
  return {
    assignmentId,
    revision,
    scores: Object.fromEntries(criteria.map((criterion) => [criterion.id, 4])),
    recommendation: "accept",
    confidence: 4,
    submitterFeedback: "Clear evidence supports this recommendation.",
    privateNotes: "Atomic batch test.",
    conflictAffirmed: true,
    intent,
  };
}

export async function reviewBatchState(assignmentId: string) {
  return env.DB.prepare(
    `SELECT assignment.status AS assignmentStatus,
            assignment.revision AS assignmentRevision,
            assignment.last_operation_id AS assignmentOperationId,
            review.id AS reviewId, review.status AS reviewStatus,
            review.revision AS reviewRevision,
            review.last_operation_id AS reviewOperationId,
            review.scores_json AS scoresJson,
            (SELECT submission.status FROM submissions submission
              WHERE submission.id = assignment.submission_id
                AND submission.event_id = assignment.event_id) AS submissionStatus,
            (SELECT COUNT(*) FROM review_revisions revision
              WHERE revision.event_id = assignment.event_id
                AND revision.review_id = review.id) AS reviewRevisionCount,
            (SELECT COUNT(*) FROM audit_events audit
              WHERE audit.event_id = assignment.event_id
                AND ((audit.entity_type = 'review' AND audit.entity_id = review.id)
                  OR (audit.entity_type = 'evaluator_assignment'
                    AND audit.entity_id = assignment.id))) AS auditCount,
            (SELECT COUNT(*) FROM webhook_deliveries delivery
              WHERE delivery.entity_type = 'review'
                AND delivery.entity_id = review.id) AS webhookDeliveryCount
       FROM evaluator_assignments assignment
       LEFT JOIN reviews review
         ON review.assignment_id = assignment.id
        AND review.event_id = assignment.event_id
      WHERE assignment.id = ? AND assignment.event_id = ?`,
  )
    .bind(assignmentId, evaluator.eventId)
    .first();
}

export async function moderationBatchState(
  roundId: string,
  submissionId: string,
) {
  return env.DB.prepare(
    `SELECT event.last_operation_id AS eventOperationId,
            submission.status AS submissionStatus,
            submission.revision AS submissionRevision,
            (SELECT COUNT(*) FROM review_moderations moderation
              WHERE moderation.event_id = event.id
                AND moderation.round_id = ?
                AND moderation.submission_id = submission.id) AS moderationCount,
            (SELECT id FROM review_moderations moderation
              WHERE moderation.event_id = event.id
                AND moderation.round_id = ?
                AND moderation.submission_id = submission.id
                AND moderation.status IN ('draft','confirmed')) AS currentModerationId,
            (SELECT status FROM review_moderations moderation
              WHERE moderation.event_id = event.id
                AND moderation.round_id = ?
                AND moderation.submission_id = submission.id
                AND moderation.status IN ('draft','confirmed')) AS currentModerationStatus,
            (SELECT COUNT(*) FROM audit_events audit
              WHERE audit.event_id = event.id
                AND audit.entity_type = 'review_moderation') AS moderationAuditCount
       FROM events event
       JOIN submissions submission
         ON submission.event_id = event.id AND submission.id = ?
      WHERE event.id = ?`,
  )
    .bind(roundId, roundId, roundId, submissionId, evaluator.eventId)
    .first();
}

export async function conflictBatchState(assignmentId: string) {
  return env.DB.prepare(
    `SELECT assignment.status, assignment.revision,
            assignment.conflict_declared_at AS conflictDeclaredAt,
            assignment.last_operation_id AS operationId,
            (SELECT COUNT(*) FROM evaluator_conflicts conflict
              WHERE conflict.event_id = assignment.event_id
                AND conflict.round_id = assignment.round_id
                AND conflict.evaluator_person_id = assignment.evaluator_person_id
                AND conflict.submission_id IS assignment.submission_id
                AND conflict.session_id IS assignment.session_id) AS conflictCount,
            (SELECT COUNT(*) FROM audit_events audit
              WHERE audit.event_id = assignment.event_id
                AND audit.action = 'review.conflict.declared'
                AND audit.entity_type = 'evaluator_assignment'
                AND audit.entity_id = assignment.id) AS conflictAuditCount
       FROM evaluator_assignments assignment
      WHERE assignment.id = ? AND assignment.event_id = ?`,
  )
    .bind(assignmentId, evaluator.eventId)
    .first();
}

export async function addReviewWebhookEndpoint(eventType: string) {
  const endpointId = `review-atomic-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO webhook_endpoints (
       id, organisation_id, event_id, name, url, secret_ciphertext,
       event_types_json, status, failure_count, created_by_person_id,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'Review atomicity', 'https://hooks.example.com/reviews',
               'test-ciphertext', ?, 'active', 0, ?, unixepoch(), unixepoch())`,
  )
    .bind(
      endpointId,
      admin.organisationId,
      admin.eventId,
      JSON.stringify([eventType]),
      admin.personId,
    )
    .run();
  return endpointId;
}
